import { logger } from "@morty-build/relay-core/logging";
import * as v from "valibot";
import { ComputerManagementError } from "../components/management/entity/computer-management.ts";
import { projectRegion } from "../components/management/entity/project-region.ts";
import { type CloudBindings, durableObjectNamespaceBindingSchema } from "../infra/cloud-bindings.ts";

export async function forwardComputerObject(
    request: Request,
    bindings: CloudBindings,
    computerId: string,
): Promise<Response> {
    const stub = computerObject(bindings, computerId);
    request.signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 120_000);
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    try {
        const body = request.body === null ? null : await request.arrayBuffer();
        signal.throwIfAborted();
        return await stub.fetch(
            new Request(request.url, {
                body,
                headers: request.headers,
                method: request.method,
                signal,
            }),
        );
    } catch (cause) {
        request.signal.throwIfAborted();
        logger.error(
            {
                event: "project_relay_request_failed",
                durableObjectClass: "ComputerRelay",
                durableObjectId: stub.id.toString(),
                computerId,
                cfRay: request.headers.get("cf-ray")?.slice(0, 128) ?? null,
                method: request.method,
                path: new URL(request.url).pathname,
                err: cause,
            },
            "Computer request failed",
        );
        throw new ComputerManagementError(
            deadline.signal.aborted ? "PROJECT_OBJECT_TIMEOUT" : "PROJECT_OBJECT_UNAVAILABLE",
            "Morty storage is unavailable.",
            deadline.signal.aborted ? 504 : 503,
            { cause },
        );
    } finally {
        clearTimeout(timer);
    }
}

export function computerObject(bindings: CloudBindings, computerId: string) {
    const parsed = v.safeParse(durableObjectNamespaceBindingSchema(), bindings.COMPUTER_RELAY);
    if (!parsed.success) {
        throw new ComputerManagementError("PROJECT_OBJECT_UNAVAILABLE", "Morty storage is unavailable.", 503);
    }
    const namespace = parsed.output;
    return namespace.get(namespace.idFromName(computerId), { locationHint: projectRegion(computerId) });
}
