import { PlatformProjectError } from "../components/management/entity/platform-project.ts";
import { projectRegion } from "../components/management/entity/project-region.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";

interface ProjectObjectNamespace {
    readonly get: (
        id: unknown,
        options?: { readonly locationHint?: "apac" | "apac-ne" | "apac-se" | "wnam" },
    ) => { readonly fetch: (request: Request) => Promise<Response> };
    readonly idFromName: (name: string) => unknown;
}

function projectObjects(value: unknown): ProjectObjectNamespace {
    if (
        typeof value !== "object" ||
        value === null ||
        !("get" in value) ||
        typeof value.get !== "function" ||
        !("idFromName" in value) ||
        typeof value.idFromName !== "function"
    ) {
        throw new PlatformProjectError("PROJECT_OBJECT_UNAVAILABLE", "Project storage is unavailable.", 503);
    }
    const get = value.get;
    const idFromName = value.idFromName;
    return {
        idFromName: (name) => Reflect.apply(idFromName, value, [name]),
        get: (id, options) => {
            const stub: unknown = Reflect.apply(get, value, [id, options]);
            if (typeof stub !== "object" || stub === null || !("fetch" in stub) || typeof stub.fetch !== "function") {
                throw new PlatformProjectError("PROJECT_OBJECT_UNAVAILABLE", "Project storage is unavailable.", 503);
            }
            const fetchObject = stub.fetch;
            return {
                fetch: async (request) => {
                    const response: unknown = await Reflect.apply(fetchObject, stub, [request]);
                    if (!(response instanceof Response)) {
                        throw new PlatformProjectError(
                            "PROJECT_OBJECT_UNAVAILABLE",
                            "Project storage is unavailable.",
                            503,
                        );
                    }
                    return response;
                },
            };
        },
    };
}

export async function routeProjectObject(
    request: Request,
    bindings: CloudBindings,
    projectId: string | null,
): Promise<Response | null> {
    if (projectId === null) {
        return null;
    }
    if (bindings.CHAT_PROJECT_ID !== undefined) {
        if (bindings.CHAT_PROJECT_ID !== projectId) {
            throw new PlatformProjectError("PROJECT_CONTEXT_MISMATCH", "The Project context is invalid.", 400);
        }
        return null;
    }
    const stub = projectObject(bindings, projectId);
    request.signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 120_000);
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    try {
        return await stub.fetch(new Request(request, { signal }));
    } catch (cause) {
        request.signal.throwIfAborted();
        throw new PlatformProjectError(
            deadline.signal.aborted ? "PROJECT_OBJECT_TIMEOUT" : "PROJECT_OBJECT_UNAVAILABLE",
            "Project storage is unavailable.",
            deadline.signal.aborted ? 504 : 503,
            { cause },
        );
    } finally {
        clearTimeout(timer);
    }
}

export function projectObject(bindings: CloudBindings, projectId: string) {
    const namespace = projectObjects(bindings.CHAT_PROJECTS);
    return namespace.get(namespace.idFromName(projectId), { locationHint: projectRegion(projectId) });
}
