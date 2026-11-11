import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { logger } from "@morty-build/relay-core/logging";
import type { ComputerRelay } from "../durable-objects/computer-relay.ts";
import { encodeComputerDurableObjectPath } from "../entity/computer-durable-object-path.ts";
import { computerIdFromPrefixedValue, decodeComputerPlacement } from "../entity/computer-id.ts";
import type { ComputerManagementStore } from "../infra/computer-management-store.ts";

export interface ComputerWorkerRoutingBindings {
    readonly COMPUTER_RELAY: DurableObjectNamespace<ComputerRelay>;
}

/** A request executing inside the Account Durable Object, beside the Project's own store. */
export interface ComputerDurableObjectExecutionBindings extends ComputerWorkerRoutingBindings {
    readonly MORTY_LOCAL_CHANNEL?: (computerId: string, request: Request) => Promise<Response>;
    readonly MORTY_COMPUTER_STORE: ComputerManagementStore;
    readonly MORTY_COMPUTER_ID: string;
}

export type ComputerDurableObjectRoutingBindings =
    | ComputerWorkerRoutingBindings
    | ComputerDurableObjectExecutionBindings;

function failure(code: string, status: number): Response {
    return Response.json({ error: { code, message: "Account routing is unavailable" } }, { status });
}

function computerIdFromPath(pathname: string): string | null {
    const prefix = `${MORTY_API_PREFIX}/v1/computers/`;
    // The connection endpoint is unscoped: its authenticated credential supplies the Computer identity.
    if (!pathname.startsWith(prefix) || pathname === `${prefix}connect`) {
        return null;
    }
    try {
        return decodeURIComponent(pathname.slice(prefix.length).split("/")[0] ?? "");
    } catch {
        return "";
    }
}

async function computerIdFromUnscopedRequest(request: Request): Promise<string | null> {
    const pathname = new URL(request.url).pathname;
    for (const segment of pathname.split("/")) {
        let value: string;
        try {
            value = decodeURIComponent(segment);
        } catch {
            return "";
        }
        const computerId = computerIdFromPrefixedValue(value);
        if (computerId !== null) {
            return computerId;
        }
    }
    const pairingPrefix = `${MORTY_API_PREFIX}/v1/pairings/`;
    if (pathname.startsWith(pairingPrefix) && pathname.endsWith("/redeem")) {
        try {
            const computerId = decodeURIComponent(pathname.slice(pairingPrefix.length, -"/redeem".length));
            return computerIdFromPrefixedValue(computerId) ?? "";
        } catch {
            return "";
        }
    }
    if (pathname === `${MORTY_API_PREFIX}/v1/computers/connect`) {
        const authorization = request.headers.get("authorization") ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
        return computerIdFromPrefixedValue(token) ?? "";
    }
    const authorization = request.headers.get("authorization") ?? "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    const credentialProject = computerIdFromPrefixedValue(bearer);
    if (credentialProject !== null) {
        return credentialProject;
    }
    return null;
}

export async function routeComputerDurableObject(
    request: Request,
    bindings: ComputerDurableObjectRoutingBindings,
    allowedOrigins: ReadonlySet<string>,
): Promise<Response | null> {
    if ("MORTY_COMPUTER_STORE" in bindings) {
        return null;
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === `${MORTY_API_PREFIX}/dashboard` || pathname.startsWith(`${MORTY_API_PREFIX}/dashboard/`)) {
        return null;
    }
    const computerId = computerIdFromPath(pathname) ?? (await computerIdFromUnscopedRequest(request));
    if (computerId === null) {
        return null;
    }
    const origin = request.headers.get("origin");
    if (origin !== null && !allowedOrigins.has("*") && !allowedOrigins.has(origin)) {
        return Response.json(
            { error: { code: "browser_origin_denied", message: "The browser origin is not allowed" } },
            { status: 403 },
        );
    }
    const placement = decodeComputerPlacement(computerId);
    if (placement === null) {
        return failure("computer_id_invalid", 400);
    }
    request.signal.throwIfAborted();
    const durableObjectUrl = new URL(request.url);
    durableObjectUrl.pathname = encodeComputerDurableObjectPath(computerId, durableObjectUrl.pathname);
    const body = request.body === null ? undefined : await request.arrayBuffer();
    request.signal.throwIfAborted();
    try {
        const computer = bindings.COMPUTER_RELAY.getByName(computerId, { locationHint: placement.locationHint });
        const routedRequest = new Request(durableObjectUrl, {
            method: request.method,
            headers: request.headers,
            ...(body === undefined ? {} : { body }),
            signal: request.signal,
            redirect: request.redirect,
        });
        return await computer.fetch(routedRequest);
    } catch (error) {
        logger.error(
            {
                event: "project_relay_request_failed",
                durableObjectClass: "ComputerRelay",
                durableObjectId: bindings.COMPUTER_RELAY.idFromName(computerId).toString(),
                computerId,
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
