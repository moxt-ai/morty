import * as v from "valibot";
import { PlatformProjectError } from "../components/management/entity/platform-project.ts";
import { projectRegion } from "../components/management/entity/project-region.ts";
import { type CloudBindings, durableObjectNamespaceBindingSchema } from "../infra/cloud-bindings.ts";

interface ComputerObjectNamespace {
    readonly get: (
        id: unknown,
        options?: { readonly locationHint?: "apac" | "apac-ne" | "apac-se" | "wnam" },
    ) => { readonly fetch: (request: Request) => Promise<Response> };
    readonly idFromName: (name: string) => unknown;
}

function computerObjects(value: unknown): ComputerObjectNamespace {
    const parsed = v.safeParse(durableObjectNamespaceBindingSchema(), value);
    if (!parsed.success) {
        throw new PlatformProjectError("PROJECT_OBJECT_UNAVAILABLE", "Morty storage is unavailable.", 503);
    }
    const namespace = parsed.output;
    const get = namespace.get;
    const idFromName = namespace.idFromName;
    return {
        idFromName: (name) => Reflect.apply(idFromName, namespace, [name]),
        get: (id, options) => {
            const stub: unknown = Reflect.apply(get, namespace, [id, options]);
            if (typeof stub !== "object" || stub === null || !("fetch" in stub) || typeof stub.fetch !== "function") {
                throw new PlatformProjectError("PROJECT_OBJECT_UNAVAILABLE", "Morty storage is unavailable.", 503);
            }
            const fetchObject = stub.fetch;
            return {
                fetch: async (request) => {
                    const response: unknown = await Reflect.apply(fetchObject, stub, [request]);
                    if (!(response instanceof Response)) {
                        throw new PlatformProjectError(
                            "PROJECT_OBJECT_UNAVAILABLE",
                            "Morty storage is unavailable.",
                            503,
                        );
                    }
                    return response;
                },
            };
        },
    };
}

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
            throw new PlatformProjectError("PROJECT_CONTEXT_MISMATCH", "The Morty context is invalid.", 400);
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
        throw new PlatformProjectError(
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
    const namespace = computerObjects(bindings.CHAT_COMPUTERS);
    return namespace.get(namespace.idFromName(computerId), { locationHint: projectRegion(computerId) });
}
