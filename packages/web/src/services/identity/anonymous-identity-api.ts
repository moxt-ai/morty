import * as v from "valibot";
import type { ApiTransport } from "../api/api-transport.ts";
import { browserAccessEntry } from "../local-storage/central-local-storage.ts";
import { CloudApiError, ManagementApi } from "../management/management-api.ts";
import { centralSessionStorage, transferRedemptionEntry } from "../session-storage/central-session-storage.ts";
import { describeBrowser } from "./device-label.ts";
import {
    type IdentityScope,
    leaveComputerAddress,
    readIdentityScope,
    writeIdentityScope,
} from "./identity-scope-url.ts";
import {
    type StoredAccessWriter,
    storedToken,
    storedTokenForProject,
    withStoredAccessLock,
} from "./remembered-computers.ts";

const tokenSchema = v.pipe(
    v.string(),
    v.regex(
        /^(?:morty_anon_v1_[A-Za-z0-9_-]{43}|morty_recovery_v1\.prj_(?:wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43})$/u,
    ),
);
const computerIdSchema = v.pipe(v.string(), v.regex(/^prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}$/u));
const userIdSchema = v.pipe(v.string(), v.minLength(8), v.maxLength(128));
const identityFields = { token: tokenSchema, userId: userIdSchema, computerId: computerIdSchema };
const identitySchema = v.pipe(v.object(identityFields), v.readonly());
/**
 * The Project a well-formed transfer code names, or null when the code cannot
 * name one. A code that was already redeemed in this browser still names its
 * Project, which is what lets a dead link fall back to the access it issued.
 */
export function transferCodeProject(code: string): string | null {
    const parts = code.split(".");
    return parts.length === 3 && parts[0] === "morty_transfer_v1" ? (parts[1] ?? null) : null;
}

/** Stored key name of the anonymous credential map, shared with browser tests. */
export const ANONYMOUS_CREDENTIAL_KEY_NAME = browserAccessEntry.key;

const anonymousSessionSchema = v.pipe(
    v.object({ authentication: v.object({ kind: v.literal("anonymous") }), userId: v.string() }),
    v.readonly(),
);
const accessTermSchema = v.object({ accessExpiresAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())) });
/** How long the device a link adds keeps access; the options this page offers; the Worker decides which it accepts. */
export const deviceAccessDurations = ["1h", "1d", "7d", "30d"] as const;
export type DeviceAccessDuration = (typeof deviceAccessDurations)[number];
const transferSchema = v.pipe(
    v.object({
        // The link opens until `expiresAt`; the device it adds keeps access until `accessExpiresAt`.
        expiresAt: v.pipe(v.string(), v.isoTimestamp()),
        accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
        /** The duration the Worker applied, its default unless one was chosen. */
        accessDuration: v.picklist(deviceAccessDurations),
        /** Whether the sharer's own access ends first, and so ends the added device's access earlier than chosen. */
        accessLimitedBySharer: v.boolean(),
        url: v.pipe(v.string(), v.url()),
    }),
    v.readonly(),
);
const deviceSharerSchema = v.variant("kind", [
    v.object({ kind: v.literal("computer") }),
    v.object({ kind: v.literal("recovery") }),
    v.object({ kind: v.literal("device"), label: v.nullable(v.string()) }),
]);
const linkedDeviceSchema = v.pipe(
    v.object({
        id: v.string(),
        joinedAt: v.pipe(v.string(), v.isoTimestamp()),
        label: v.nullable(v.string()),
        /** Roughly where it joined from, as Cloudflare located it; null when location is unavailable. */
        location: v.nullable(
            v.object({
                city: v.nullable(v.string()),
                country: v.nullable(v.pipe(v.string(), v.regex(/^[A-Z]{2}$/u))),
            }),
        ),
        accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
        addedBy: v.nullable(deviceSharerSchema),
    }),
    v.readonly(),
);
export type LinkedDevice = v.InferOutput<typeof linkedDeviceSchema>;
const linkedDevicesSchema = v.object({ devices: v.array(linkedDeviceSchema) });
const deviceAccessEndedSchema = v.object({ status: v.literal("device_access_ended") });
const otherBrowserAccessEndedSchema = v.object({ status: v.literal("other_browser_access_ended") });
const credentialRevocationPathSchema = v.picklist([
    "/identity/v1/local-credential",
    "/identity/v1/browser-access",
    "/identity/v1/recovery-credential",
]);
export type AnonymousIdentity = v.InferOutput<typeof identitySchema>;
export type IdentityTransfer = v.InferOutput<typeof transferSchema>;
/** What a new link grants, and the unopened link from this page it replaces. */
export interface SharingTerms {
    /** The same operation is retained until its outcome is known. */
    readonly operationId: string;
    /** The chosen duration, or null for the Worker's default. */
    readonly accessDuration: DeviceAccessDuration | null;
    /** The code of a link this page shared that no one opened yet; it stops working. */
    readonly replaces: string | null;
}

/**
 * What checking access this browser stores found. Access that no longer opens its computer is forgotten either way;
 * `revoked` is the Worker reporting that the access was ended, `gone` is any other access that stopped opening it.
 */
export type AccessCheck = { readonly kind: "open"; readonly identity: AnonymousIdentity } | LostAccess;

/** An access check that found the access no longer opens its computer. */
export type LostAccess = { readonly kind: "revoked" } | { readonly kind: "gone" };

/** The reason the Worker gives, beside UNAUTHENTICATED, for a credential whose access was ended. */
const ACCESS_REVOKED = "ACCESS_REVOKED";

export type DataRegion =
    | "wnam"
    | "enam"
    | "sam"
    | "weur"
    | "eeur"
    | "apac"
    | "apac-ne"
    | "apac-se"
    | "oc"
    | "afr"
    | "me";

interface Options {
    readonly fetchRequest: (request: Request) => Promise<Response>;
    readonly origin: string;
}

/**
 * This tab's key for redeeming `code`. It is kept until the access the redemption returns is saved, so retrying or
 * reloading after a lost reply repeats the same redemption and gets that access back.
 */
function transferRedemptionKey(code: string): string {
    const kept = centralSessionStorage.read(transferRedemptionEntry);
    if (kept?.code === code) {
        return kept.key;
    }
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
    centralSessionStorage.write(transferRedemptionEntry, { code, key });
    return key;
}

export class AnonymousIdentityApi {
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #origin: string;

    constructor(options: Options) {
        this.#fetchRequest = options.fetchRequest;
        this.#origin = v.parse(v.pipe(v.string(), v.url()), options.origin);
    }

    readonly loadScope = async (scope: IdentityScope, signal: AbortSignal): Promise<AnonymousIdentity | null> => {
        const checked = await this.checkScope(scope, signal);
        return checked.kind === "open" ? checked.identity : null;
    };

    /**
     * Validate one access without navigating or changing recency. Access another tab replaced while the check ran,
     * including a replacement still being saved, is checked in turn instead of being forgotten with the access it
     * replaced.
     */
    readonly checkScope = async (scope: IdentityScope, signal: AbortSignal): Promise<AccessCheck> => {
        for (;;) {
            signal.throwIfAborted();
            const token = storedToken(scope.userId);
            if (token === null) {
                return { kind: "gone" };
            }
            const checked = await this.#checkAccess({ ...scope, token }, signal);
            if (checked.kind === "open") {
                return checked;
            }
            // A tab replacing this access holds the lock until it saves the replacement, so forgetting waits for it
            // and checks the replacement instead. Access another check already forgot keeps this check's verdict.
            if (
                await withStoredAccessLock(
                    signal,
                    async (access) => access.forgetRejected(scope, token) || storedToken(scope.userId) === null,
                )
            ) {
                return checked;
            }
        }
    };

    /** Whether the access still opens its computer. */
    readonly #checkAccess = async (identity: AnonymousIdentity, signal: AbortSignal): Promise<AccessCheck> => {
        const session = await this.#anonymousSession(identity, signal);
        signal.throwIfAborted();
        if (session === "revoked") {
            return { kind: "revoked" };
        }
        if (session?.userId !== identity.userId) {
            return { kind: "gone" };
        }
        const management = new ManagementApi({
            fetchRequest: this.#fetchRequest,
            origin: this.#origin,
            computerId: identity.computerId,
            getToken: async (requestSignal) => {
                requestSignal.throwIfAborted();
                return identity.token;
            },
        });
        try {
            const computer = await management.readProject(signal);
            signal.throwIfAborted();
            if (computer === null) {
                return { kind: "gone" };
            }
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof CloudApiError && (cause.status === 401 || cause.status === 403)) {
                // The session answered before the computer refused this access: access ended in between is reported
                // as ended, not as a link that does not open the computer.
                const session = await this.#anonymousSession(identity, signal);
                signal.throwIfAborted();
                return session === "revoked" ? { kind: "revoked" } : { kind: "gone" };
            }
            throw cause;
        }
        return { kind: "open", identity };
    };

    readonly createTransfer = async (
        token: string,
        terms: SharingTerms,
        signal: AbortSignal,
    ): Promise<IdentityTransfer> =>
        v.parse(
            transferSchema,
            await this.#request(
                "/identity/transfers",
                {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${v.parse(tokenSchema, token)}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({
                        operationId: terms.operationId,
                        ...(terms.accessDuration === null ? {} : { accessDuration: terms.accessDuration }),
                        ...(terms.replaces === null ? {} : { replaces: terms.replaces }),
                    }),
                },
                signal,
            ),
        );

    /**
     * Opens a link in this browser. A browser keeps one access per user: the access it already holds for the link's
     * Project is replaced by the new one, which also takes over the links it came from.
     */
    readonly redeemTransfer = async (code: string, signal: AbortSignal): Promise<AnonymousIdentity> =>
        await withStoredAccessLock(signal, (access) => this.#redeemTransfer(code, signal, access));

    readonly #redeemTransfer = async (
        code: string,
        signal: AbortSignal,
        access: StoredAccessWriter,
    ): Promise<AnonymousIdentity> => {
        const computerId = transferCodeProject(code);
        const replaces = computerId === null ? null : storedTokenForProject(computerId);
        const redemptionKey = transferRedemptionKey(code);
        const identity = v.parse(
            identitySchema,
            await this.#request(
                "/identity/transfers/redeem",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        code,
                        ...(replaces === null ? {} : { replaces }),
                        device: describeBrowser(navigator.userAgent),
                        redemptionKey,
                    }),
                },
                signal,
            ),
        );
        this.#saveIdentity(identity, access);
        centralSessionStorage.remove(transferRedemptionEntry);
        return identity;
    };

    /** Resolves once the devices holding this access through a link differ from the list this client last read. */
    readonly waitForLinkedDevicesChange = async (
        token: string,
        waitForChange: ApiTransport["waitForChange"],
        signal: AbortSignal,
    ): Promise<void> =>
        await waitForChange(
            new Request(this.#url("/identity/devices"), {
                method: "GET",
                headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` },
                signal,
            }),
        );

    /** When this access ends: the browser's device term, the latest among the links it opened; null without one. */
    readonly accessExpiresAt = async (token: string, signal: AbortSignal): Promise<string | null> =>
        v.parse(
            accessTermSchema,
            await this.#request(
                "/session",
                { method: "GET", headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` } },
                signal,
            ),
        ).accessExpiresAt;

    /** The other devices that hold this access through a link now. */
    readonly linkedDevices = async (token: string, signal: AbortSignal): Promise<readonly LinkedDevice[]> =>
        v.parse(
            linkedDevicesSchema,
            await this.#request(
                "/identity/devices",
                { method: "GET", headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` } },
                signal,
            ),
        ).devices;

    /**
     * Ends the access of every other browser that joined through a link, and closes the chat windows open with it;
     * this browser and the computer keep theirs. Repeating it after a failure is safe.
     */
    readonly endOtherBrowserAccess = async (token: string, signal: AbortSignal): Promise<void> => {
        v.parse(
            otherBrowserAccessEndedSchema,
            await this.#request(
                "/identity/v1/other-browser-access",
                { method: "DELETE", headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` } },
                signal,
            ),
        );
    };

    /** Ends one other device's access and closes the chat windows open with it; repeating it after a failure is safe. */
    readonly endDeviceAccess = async (token: string, deviceId: string, signal: AbortSignal): Promise<void> => {
        v.parse(
            deviceAccessEndedSchema,
            await this.#request(
                `/identity/v1/devices/${encodeURIComponent(deviceId)}`,
                { method: "DELETE", headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` } },
                signal,
            ),
        );
    };

    readonly endRemoteAccess = async (
        token: string,
        signal: AbortSignal,
        access: StoredAccessWriter,
    ): Promise<void> => {
        const headers = { authorization: `Bearer ${v.parse(tokenSchema, token)}` };
        const session = await this.#response("/session", { method: "GET", headers }, signal);
        await session.body?.cancel();
        // The Worker names the deletion that ends this credential's kind.
        const path = v.parse(credentialRevocationPathSchema, session.headers.get("Morty-Credential-Revocation"));
        await this.#request(path, { method: "DELETE", headers }, signal);
        const scope = readIdentityScope();
        if (scope !== null) {
            access.forget(scope);
        }
        leaveComputerAddress();
    };

    readonly #saveIdentity = (identity: AnonymousIdentity, access: StoredAccessWriter) => {
        const scope = { computerId: identity.computerId, userId: identity.userId };
        access.save(scope, identity.token);
        writeIdentityScope(scope);
    };

    readonly #anonymousSession = async (
        identity: AnonymousIdentity,
        requestSignal: AbortSignal,
    ): Promise<v.InferOutput<typeof anonymousSessionSchema> | "revoked" | null> => {
        try {
            return v.parse(
                anonymousSessionSchema,
                await this.#request(
                    `/computers/${encodeURIComponent(identity.computerId)}/session`,
                    {
                        method: "GET",
                        headers: {
                            authorization: `Bearer ${identity.token}`,
                        },
                    },
                    requestSignal,
                ),
            );
        } catch (error) {
            requestSignal.throwIfAborted();
            if (error instanceof IdentityApiError && error.status === 401 && error.reason === ACCESS_REVOKED) {
                return "revoked";
            }
            if (error instanceof IdentityApiError && (error.status === 401 || error.status === 403)) {
                return null;
            }
            throw error;
        }
    };

    readonly #request = async (path: string, init: RequestInit, requestSignal: AbortSignal): Promise<unknown> => {
        const response = await this.#response(path, init, requestSignal);
        const value: unknown = response.status === 204 ? null : await response.json();
        requestSignal.throwIfAborted();
        return value;
    };

    readonly #url = (path: string): URL => {
        const scope = readIdentityScope();
        const scopedPath =
            scope !== null && !path.startsWith("/computers/") && path !== "/identity/transfers/redeem"
                ? `/computers/${encodeURIComponent(scope.computerId)}${path}`
                : path;
        return new URL(`/morty/api${scopedPath}`, this.#origin);
    };

    readonly #response = async (path: string, init: RequestInit, requestSignal: AbortSignal): Promise<Response> => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(30_000)]);
        const headers = new Headers(init.headers);
        const response = await this.#fetchRequest(new Request(this.#url(path), { ...init, headers, signal }));
        signal.throwIfAborted();
        if (!response.ok) {
            const value: unknown = await response.json();
            signal.throwIfAborted();
            const error = v.safeParse(
                v.object({
                    error: v.object({ code: v.string(), message: v.string(), reason: v.optional(v.string()) }),
                }),
                value,
            );
            throw new IdentityApiError(
                error.success ? error.output.error.code : "IDENTITY_UNAVAILABLE",
                error.success ? error.output.error.message : "Identity service is unavailable.",
                response.status,
                error.success ? (error.output.error.reason ?? null) : null,
            );
        }
        return response;
    };
}

export class IdentityApiError extends Error {
    readonly code: string;
    readonly status: number | null;
    /** The finer cause the Worker names beside `code`, when it names one. */
    readonly reason: string | null;
    constructor(code: string, message: string, status: number | null = null, reason: string | null = null) {
        super(message);
        this.code = code;
        this.status = status;
        this.reason = reason;
        this.name = "IdentityApiError";
    }
}
