import { type Identifier, isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";
import type { ApiTransport } from "../api/api-transport.ts";
import { anonymousCredentialsEntry } from "../local-storage/central-local-storage.ts";
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
    forgetComputer,
    forgetComputerAccess,
    rememberComputer,
    saveAccess,
    storedToken,
    storedTokenForProject,
    withStoredAccessLock,
} from "./remembered-computers.ts";

const tokenSchema = v.pipe(
    v.string(),
    v.regex(
        /^(?:mobius_anon_v2_[A-Za-z0-9_-]{43}|mobius_recovery_v1\.prj_(?:wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43})$/u,
    ),
);
const recoveryTokenSchema = v.pipe(
    v.string(),
    v.regex(/^mobius_recovery_v1\.prj_(?:wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/u),
);
const projectIdSchema = v.pipe(v.string(), v.regex(/^prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}$/u));
const botIdSchema = v.custom<Identifier>(isIdentifier);
const userIdSchema = v.pipe(v.string(), v.minLength(8), v.maxLength(128));
const identityFields = { token: tokenSchema, botId: botIdSchema, userId: userIdSchema, projectId: projectIdSchema };
const identitySchema = v.pipe(v.object(identityFields), v.readonly());
/**
 * The Project a well-formed transfer code names, or null when the code cannot
 * name one. A code that was already redeemed in this browser still names its
 * Project, which is what lets a dead link fall back to the access it issued.
 */
export function transferCodeProject(code: string): string | null {
    const parts = code.split(".");
    return parts.length === 3 && parts[0] === "mobius_transfer_v2" ? (parts[1] ?? null) : null;
}

/** Stored key name of the anonymous credential map, shared with browser tests. */
export const ANONYMOUS_CREDENTIAL_KEY_NAME = anonymousCredentialsEntry.key;

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
        /** Roughly where it joined from, as Cloudflare located it; null for devices that joined before this was kept. */
        location: v.nullable(
            v.object({
                city: v.nullable(v.string()),
                country: v.nullable(v.pipe(v.string(), v.regex(/^[A-Z]{2}$/u))),
            }),
        ),
        accessExpiresAt: v.pipe(v.string(), v.isoTimestamp()),
        // A Worker that predates sharers, or a sharer it does not know, names none.
        addedBy: v.fallback(v.nullable(deviceSharerSchema), null),
    }),
    v.readonly(),
);
export type LinkedDevice = v.InferOutput<typeof linkedDeviceSchema>;
const linkedDevicesSchema = v.object({ devices: v.array(linkedDeviceSchema) });
const deviceAccessEndedSchema = v.object({
    status: v.literal("device_access_ended"),
    sessionAccess: v.picklist(["revoked", "unconfirmed"]),
});
const otherBrowserAccessEndedSchema = v.object({
    status: v.literal("other_browser_access_ended"),
    sessionAccess: v.picklist(["revoked", "unconfirmed"]),
});
/** Whether the chat windows already open on the disconnected browsers were closed too. */
export type OpenWindowsAfterDisconnect = "closed" | "unconfirmed";
const credentialRevocationPathSchema = v.picklist([
    "/identity/v1/local-credential",
    "/identity/v1/browser-access",
    "/identity/v1/recovery-credential",
]);
export type AnonymousIdentity = v.InferOutput<typeof identitySchema>;
export type IdentityTransfer = v.InferOutput<typeof transferSchema>;
/** What a new link grants, and the unopened link from this page it replaces. */
export interface SharingTerms {
    /** The chosen duration, or null for the Worker's default. */
    readonly accessDuration: DeviceAccessDuration | null;
    /** The code of a link this page shared that no one opened yet; it stops working. */
    readonly replaces: string | null;
}

/**
 * What checking access this browser stores found. Access that no longer opens its computer is forgotten either way;
 * `revoked` is the Worker reporting that the access was ended, `gone` is any other access that stopped opening it.
 */
export type AccessCheck =
    | { readonly kind: "open"; readonly identity: AnonymousIdentity }
    | { readonly kind: "revoked" }
    | { readonly kind: "gone" };

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
                forgetComputer(scope);
                return { kind: "gone" };
            }
            const checked = await this.#checkAccess({ ...scope, token }, signal);
            if (checked.kind === "open") {
                rememberComputer(scope);
                return checked;
            }
            // A tab replacing this access holds the lock until it saves the replacement, so forgetting waits for it
            // and checks the replacement instead. Access another check already forgot keeps this check's verdict.
            if (
                await withStoredAccessLock(
                    signal,
                    async () => forgetComputerAccess(scope, token) || storedToken(scope.userId) === null,
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
            projectId: identity.projectId,
            getToken: async (requestSignal) => {
                requestSignal.throwIfAborted();
                return identity.token;
            },
        });
        try {
            await management.readBot(identity.botId, signal);
            signal.throwIfAborted();
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof CloudApiError && cause.code === "BOT_NOT_FOUND") {
                return { kind: "gone" };
            }
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
        await withStoredAccessLock(signal, () => this.#redeemTransfer(code, signal));

    readonly #redeemTransfer = async (code: string, signal: AbortSignal): Promise<AnonymousIdentity> => {
        const projectId = transferCodeProject(code);
        const replaces = projectId === null ? null : storedTokenForProject(projectId);
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
        this.#saveIdentity(identity);
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

    /** When this access ends: the term of the link a browser came through, or null for access without one. */
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

    /** Ends the access of every other browser that joined through a link; this browser and the computer keep theirs. */
    readonly endOtherBrowserAccess = async (token: string, signal: AbortSignal): Promise<OpenWindowsAfterDisconnect> =>
        v.parse(
            otherBrowserAccessEndedSchema,
            await this.#request(
                "/identity/v1/other-browser-access",
                { method: "DELETE", headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` } },
                signal,
            ),
        ).sessionAccess === "revoked"
            ? "closed"
            : "unconfirmed";

    /** Ends one other device's access; repeating it after an uncertain result is safe. */
    readonly endDeviceAccess = async (
        token: string,
        deviceId: string,
        signal: AbortSignal,
    ): Promise<OpenWindowsAfterDisconnect> =>
        v.parse(
            deviceAccessEndedSchema,
            await this.#request(
                `/identity/v1/devices/${encodeURIComponent(deviceId)}`,
                { method: "DELETE", headers: { authorization: `Bearer ${v.parse(tokenSchema, token)}` } },
                signal,
            ),
        ).sessionAccess === "revoked"
            ? "closed"
            : "unconfirmed";

    readonly endRemoteAccess = async (token: string, signal: AbortSignal): Promise<void> => {
        const headers = { authorization: `Bearer ${v.parse(tokenSchema, token)}` };
        const session = await this.#response("/session", { method: "GET", headers }, signal);
        await session.body?.cancel();
        // The Worker names the deletion that ends this credential's kind.
        const path = v.parse(credentialRevocationPathSchema, session.headers.get("Morty-Credential-Revocation"));
        await this.#request(path, { method: "DELETE", headers }, signal);
        const scope = readIdentityScope();
        if (scope !== null) {
            forgetComputer(scope);
        }
        leaveComputerAddress();
    };

    readonly createRecoveryToken = async (
        accessToken: string,
        projectId: string,
        signal: AbortSignal,
    ): Promise<string> => {
        const result = v.parse(
            v.object({ token: recoveryTokenSchema }),
            await this.#request(
                `/projects/${encodeURIComponent(v.parse(projectIdSchema, projectId))}/identity/recovery-token`,
                { method: "POST", headers: { authorization: `Bearer ${v.parse(tokenSchema, accessToken)}` } },
                signal,
            ),
        );
        return result.token;
    };

    readonly saveIdentity = (identity: AnonymousIdentity): void =>
        this.#saveIdentity(v.parse(identitySchema, identity));

    readonly #saveIdentity = (identity: AnonymousIdentity) => {
        const scope = { botId: identity.botId, projectId: identity.projectId, userId: identity.userId };
        saveAccess(scope, identity.token);
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
                    `/projects/${encodeURIComponent(identity.projectId)}/session`,
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
            scope !== null && !path.startsWith("/projects/") && path !== "/identity/transfers/redeem"
                ? `/projects/${encodeURIComponent(scope.projectId)}${path}`
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
