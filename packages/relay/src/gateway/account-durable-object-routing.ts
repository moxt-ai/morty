import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { logger } from "@morty-build/relay-core/logging";
import type { AccountDO } from "../durable-objects/account-do.ts";
import { encodeAccountDurableObjectPath } from "../entity/account-durable-object-path.ts";
import { accountIdFromPrefixedValue, decodeAccountPlacement } from "../entity/machine-account-id.ts";
import type { PlatformProjectStore } from "../infra/platform-project-store.ts";

export interface AccountWorkerRoutingBindings {
    readonly ACCOUNT_RELAY: DurableObjectNamespace<AccountDO>;
}

/** A request executing inside the Account Durable Object, beside the Project's own store. */
export interface AccountDurableObjectExecutionBindings extends AccountWorkerRoutingBindings {
    readonly MORTY_ACCOUNT_STORE: PlatformProjectStore;
    readonly MORTY_ACCOUNT_ID: string;
}

export type AccountDurableObjectRoutingBindings = AccountWorkerRoutingBindings | AccountDurableObjectExecutionBindings;

function failure(code: string, status: number): Response {
    return Response.json({ error: { code, message: "Account routing is unavailable" } }, { status });
}

function accountIdFromPath(pathname: string): string | null {
    const prefix = `${MORTY_API_PREFIX}/v1/accounts/`;
    if (!pathname.startsWith(prefix)) {
        return null;
    }
    try {
        return decodeURIComponent(pathname.slice(prefix.length).split("/")[0] ?? "");
    } catch {
        return "";
    }
}

async function accountIdFromUnscopedRequest(request: Request): Promise<string | null> {
    const pathname = new URL(request.url).pathname;
    for (const segment of pathname.split("/")) {
        let value: string;
        try {
            value = decodeURIComponent(segment);
        } catch {
            return "";
        }
        const accountId = accountIdFromPrefixedValue(value);
        if (accountId !== null) {
            return accountId;
        }
    }
    const pairingPrefix = `${MORTY_API_PREFIX}/v1/runtime-pairings/`;
    if (pathname.startsWith(pairingPrefix) && pathname.endsWith("/redeem")) {
        try {
            const pairingId = decodeURIComponent(pathname.slice(pairingPrefix.length, -"/redeem".length));
            return accountIdFromPrefixedValue(pairingId) ?? "";
        } catch {
            return "";
        }
    }
    if (pathname === `${MORTY_API_PREFIX}/v1/runtimes/connect`) {
        const authorization = request.headers.get("authorization") ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
        return accountIdFromPrefixedValue(token) ?? "";
    }
    const authorization = request.headers.get("authorization") ?? "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    const credentialProject = accountIdFromPrefixedValue(bearer);
    if (credentialProject !== null) {
        return credentialProject;
    }
    return null;
}

export async function routeAccountDurableObject(
    request: Request,
    bindings: AccountDurableObjectRoutingBindings,
    allowedOrigins: ReadonlySet<string>,
): Promise<Response | null> {
    if ("MORTY_ACCOUNT_STORE" in bindings) {
        return null;
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === `${MORTY_API_PREFIX}/dashboard` || pathname.startsWith(`${MORTY_API_PREFIX}/dashboard/`)) {
        return null;
    }
    const accountId = accountIdFromPath(pathname) ?? (await accountIdFromUnscopedRequest(request));
    if (accountId === null) {
        return null;
    }
    const origin = request.headers.get("origin");
    if (origin !== null && !allowedOrigins.has("*") && !allowedOrigins.has(origin)) {
        return Response.json(
            { error: { code: "browser_origin_denied", message: "The browser origin is not allowed" } },
            { status: 403 },
        );
    }
    const placement = decodeAccountPlacement(accountId);
    if (placement === null) {
        return failure("project_id_invalid", 400);
    }
    request.signal.throwIfAborted();
    const durableObjectUrl = new URL(request.url);
    durableObjectUrl.pathname = encodeAccountDurableObjectPath(accountId, durableObjectUrl.pathname);
    const body = request.body === null ? undefined : await request.arrayBuffer();
    request.signal.throwIfAborted();
    try {
        return await bindings.ACCOUNT_RELAY.getByName(accountId, { locationHint: placement.locationHint }).fetch(
            durableObjectUrl,
            {
                method: request.method,
                headers: request.headers,
                ...(body === undefined ? {} : { body }),
                signal: request.signal,
                redirect: request.redirect,
            },
        );
    } catch (error) {
        logger.error(
            {
                event: "project_relay_request_failed",
                durableObjectClass: "AccountDO",
                durableObjectId: bindings.ACCOUNT_RELAY.idFromName(accountId).toString(),
                accountId,
                cfRay: request.headers.get("cf-ray")?.slice(0, 128) ?? null,
                method: request.method,
                path: durableObjectUrl.pathname,
                err: error,
            },
            "Project Relay request failed",
        );
        throw error;
    }
}
