import * as v from "valibot";
import { ComputerManagementError } from "../components/management/entity/computer-management.ts";
import { projectRegion } from "../components/management/entity/project-region.ts";
import { type CloudBindings, durableObjectNamespaceBindingSchema } from "../infra/cloud-bindings.ts";

export async function routeComputerObject(
    request: Request,
    bindings: CloudBindings,
    computerId: string | null,
): Promise<Response | null> {
    if (computerId === null) {
        return null;
    }
    if (bindings.CHAT_COMPUTER_ID !== undefined) {
        if (bindings.CHAT_COMPUTER_ID !== computerId) {
            throw new ComputerManagementError("PROJECT_CONTEXT_MISMATCH", "The Morty context is invalid.", 400);
        }
        return null;
    }
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
