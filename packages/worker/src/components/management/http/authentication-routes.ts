import { Hono } from "hono";
import * as v from "valibot";
import { admitAnonymousCreation } from "../../../gateway/anonymous-creation-admission.ts";
import { computerObject } from "../../../gateway/computer-object-routing.ts";
import { json } from "../../../infra/http.ts";
import { bodyParser, readJsonBody } from "../../../middleware/body-parser.ts";
import {
    credentialRevocationPaths,
    defaultDeviceAccessDuration,
    deviceAccessDurations,
    localCredentialToken,
} from "../entity/authentication/credential.ts";
import { clientLocationHeader, decodeClientLocation } from "../entity/client-location.ts";
import { anonymousCreationKey } from "../entity/computer-bootstrap.ts";
import { ManagementError } from "../entity/management-error.ts";
import { projectLocationHint } from "../util/project-location.ts";
import { credentialRejected, localIdentityRequired } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

const shareInput = v.pipe(
    v.object({
        /** Stable across retries of this exact issuance intent. */
        operationId: v.pipe(v.string(), v.uuid()),
        /** How long the device the link adds keeps access; a day unless chosen. */
        accessDuration: v.optional(v.picklist(deviceAccessDurations)),
        /** A link this access shared that no one opened yet; it stops working once the new one is issued. */
        replaces: v.optional(v.pipe(v.string(), v.maxLength(512))),
    }),
    v.readonly(),
);
const transferInput = v.pipe(
    v.object({
        code: v.string(),
        /** The credential this browser already holds for the link's Project, which the new one replaces. */
        replaces: v.optional(v.pipe(v.string(), v.maxLength(512))),
        /** How the browser describes itself, such as "iPhone · Safari"; shown to the owner's other devices. */
        device: v.optional(v.pipe(v.string(), v.trim(), v.regex(/^[^\p{C}]{1,80}$/u))),
        /** A browser-held secret naming this redemption, so repeating it after a lost reply returns the same access. */
        redemptionKey: v.optional(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u))),
    }),
    v.readonly(),
);
const revokeAllAccessInput = v.pipe(
    v.strictObject({
        /** The local credential that replaces the caller's; setup saved it before sending this request. */
        successor: localCredentialToken,
    }),
    v.readonly(),
);
const anonymousUserInput = v.strictObject({
    creationKey: anonymousCreationKey,
    locationHint: v.optional(
        v.picklist(["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"]),
    ),
});

/** The user a creation key names. A one-way digest, so the public user ID never reveals the key. */
async function anonymousUserId(creationKey: string): Promise<string> {
    const digest = new Uint8Array(
        await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify(["morty-anonymous-user-v1", creationKey])),
        ),
    );
    const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `usr_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createAuthenticationRoutes() {
    return new Hono<ManagementHttpEnvironment>()
        .all("/session", async (context) => {
            const request = context.req.raw;
            if (request.method !== "GET") {
                throw new ManagementError("METHOD_NOT_ALLOWED", "Method not allowed.", 405, {
                    Allow: "GET",
                });
            }
            const token = context.get("bearerToken");
            const result = await context.env.services.authentication.session(token, request.signal);
            switch (result.kind) {
                case "authenticated":
                    // A browser's access ends at its device's term, the latest among the links the device opened; other
                    // credentials have none.
                    return json(
                        {
                            ...result.session,
                            accessExpiresAt:
                                result.accessExpiresAt === null ? null : new Date(result.accessExpiresAt).toISOString(),
                        },
                        200,
                        {
                            "Cache-Control": "no-store",
                            "Morty-Credential-Revocation": credentialRevocationPaths[result.credentialKind],
                        },
                    );
                case "unauthenticated":
                case "revoked":
                    throw credentialRejected(result.kind);
            }
        })
        .post("/identity/anonymous-users", async (context) => {
            const request = context.req.raw;
            const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45000)]);
            const input = v.parse(anonymousUserInput, await readJsonBody(request));
            signal.throwIfAborted();
            await admitAnonymousCreation(request, context.env.config.bindings);
            signal.throwIfAborted();
            // Retrying the same creation key names the same user, whose Relay Project creation is idempotent and
            // whose bootstrap returns the identity an earlier attempt issued.
            const userId = await anonymousUserId(input.creationKey);
            const project = await context.env.gateways.computerManagements.create(
                userId,
                "Morty",
                signal,
                input.locationHint ?? projectLocationHint(request),
            );
            const response = await computerObject(context.env.config.bindings, project.computerId).fetch(
                new Request("https://computer.internal/__computer/bootstrap", {
                    body: JSON.stringify({
                        computer: project,
                        userId,
                        origin: { kind: "created", creationKey: input.creationKey },
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal,
                }),
            );
            signal.throwIfAborted();
            return response;
        })
        .post(
            "/identity/transfers",
            bodyParser<ManagementHttpEnvironment, typeof shareInput>(shareInput),
            async (context) => {
                const input = context.req.valid("json");
                const transfer = await context.env.services.authentication.createTransfer(
                    context.get("bearerToken"),
                    {
                        operationId: input.operationId,
                        duration: input.accessDuration ?? defaultDeviceAccessDuration,
                        replaces: input.replaces ?? null,
                    },
                    context.req.raw.signal,
                );
                if (transfer === null) {
                    throw new ManagementError("UNAUTHENTICATED", "Anonymous identity is required.", 401);
                }
                const url = new URL(
                    "/continue",
                    v.parse(v.pipe(v.string(), v.url()), context.env.config.bindings.APP_ORIGIN),
                );
                url.hash = `code=${transfer.code}`;
                return json(
                    {
                        expiresAt: new Date(transfer.expiresAt).toISOString(),
                        accessExpiresAt: new Date(transfer.accessExpiresAt).toISOString(),
                        accessDuration: transfer.accessDuration,
                        accessLimitedBySharer: transfer.accessLimitedBySharer,
                        url: url.toString(),
                    },
                    201,
                );
            },
        )
        .post("/identity/recovery-token", async (context) => {
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]);
            const result = await context.env.services.authentication.createRecoveryToken(
                context.get("bearerToken"),
                signal,
            );
            switch (result.kind) {
                case "issued":
                    return json({ token: result.token }, 201, { "Cache-Control": "no-store" });
                case "unauthenticated":
                    throw new ManagementError("UNAUTHENTICATED", "Anonymous identity is required.", 401);
                case "forbidden":
                    throw localIdentityRequired();
            }
        })
        .get("/identity/devices", async (context) => {
            const result = await context.env.services.authentication.linkedDevices(
                context.get("bearerToken"),
                context.req.raw.signal,
            );
            if (result.kind !== "listed") {
                throw credentialRejected(result.kind);
            }
            return json(
                {
                    devices: result.devices.map((device) => ({
                        id: device.id,
                        joinedAt: new Date(device.joinedAt).toISOString(),
                        label: device.label,
                        location: device.location,
                        addedBy: device.addedBy,
                        accessExpiresAt: new Date(device.accessExpiresAt).toISOString(),
                    })),
                },
                200,
                { "Cache-Control": "no-store" },
            );
        })
        .post(
            "/identity/transfers/redeem",
            bodyParser<ManagementHttpEnvironment, typeof transferInput>(transferInput),
            async (context) => {
                const input = context.req.valid("json");
                const identity = await context.env.services.management.redeemTransfer(
                    input.code,
                    input.replaces ?? null,
                    {
                        label: input.device ?? null,
                        location: decodeClientLocation(context.req.raw.headers.get(clientLocationHeader)),
                    },
                    input.redemptionKey ?? null,
                    context.req.raw.signal,
                );
                if (identity === null) {
                    throw new ManagementError(
                        "TRANSFER_UNAVAILABLE",
                        "This link was already used, has expired, or was revoked.",
                        410,
                    );
                }
                return json(identity);
            },
        )
        .post(
            "/identity/revoke-all-access",
            bodyParser<ManagementHttpEnvironment, typeof revokeAllAccessInput>(revokeAllAccessInput),
            async (context) => {
                const result = await context.env.services.authentication.revokeAllAccess(
                    context.get("bearerToken"),
                    context.req.valid("json").successor,
                    context.req.raw.signal,
                );
                switch (result.kind) {
                    case "revoked":
                        return json({ status: "access_revoked" }, 200, { "Cache-Control": "no-store" });
                    case "unauthenticated":
                        throw new ManagementError("UNAUTHENTICATED", "Local identity is required.", 401);
                    case "forbidden":
                        throw new ManagementError(
                            "LOCAL_IDENTITY_REQUIRED",
                            "Use the original identity saved on the machine to revoke all access.",
                            403,
                        );
                }
            },
        )
        .delete("/identity/v1/other-browser-access", async (context) => {
            const result = await context.env.services.authentication.endOtherBrowserAccess(
                context.get("bearerToken"),
                context.req.raw.signal,
            );
            switch (result.kind) {
                case "ended":
                    return json({ status: "other_browser_access_ended" }, 200, { "Cache-Control": "no-store" });
                case "unauthenticated":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
                case "forbidden":
                    throw new ManagementError(
                        "CREDENTIAL_KIND_REQUIRED",
                        "This operation requires a different credential kind.",
                        403,
                    );
            }
        })
        .delete("/identity/v1/devices/:deviceId", async (context) => {
            const result = await context.env.services.authentication.endDeviceAccess(
                context.get("bearerToken"),
                context.req.param("deviceId"),
                context.req.raw.signal,
            );
            switch (result.kind) {
                case "ended":
                    return json({ status: "device_access_ended" }, 200, { "Cache-Control": "no-store" });
                case "own":
                    throw new ManagementError(
                        "OWN_DEVICE",
                        "End this browser's access with End current access instead.",
                        409,
                    );
                case "unknown":
                    throw new ManagementError("DEVICE_NOT_FOUND", "No such device has access to this computer.", 404);
                case "unauthenticated":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
                case "forbidden":
                    throw new ManagementError(
                        "CREDENTIAL_KIND_REQUIRED",
                        "This operation requires a different credential kind.",
                        403,
                    );
            }
        })
        .delete(credentialRevocationPaths.browser, async (context) => {
            return endAccessResponse(
                await context.env.services.authentication.endBrowserAccess(
                    context.get("bearerToken"),
                    context.req.raw.signal,
                ),
            );
        })
        .delete(credentialRevocationPaths.recovery, async (context) => {
            return endAccessResponse(
                await context.env.services.authentication.revokeRecoveryCredential(
                    context.get("bearerToken"),
                    context.req.raw.signal,
                ),
            );
        })
        .delete(credentialRevocationPaths.local, async (context) => {
            return endAccessResponse(
                await context.env.services.authentication.retireLocalCredential(
                    context.get("bearerToken"),
                    context.req.raw.signal,
                ),
            );
        });
}

// Deletion answers 204; a credential that no longer authenticates answers 401, so a retry after a lost reply is safe.
// A timeout is ambiguous: retry the same operation.
function endAccessResponse(result: { readonly kind: "ended" | "unauthenticated" | "forbidden" }): Response {
    switch (result.kind) {
        case "ended":
            return new Response(null, { status: 204 });
        case "unauthenticated":
            throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
        case "forbidden":
            throw new ManagementError(
                "CREDENTIAL_KIND_REQUIRED",
                "This operation requires a different credential kind.",
                403,
            );
    }
}
