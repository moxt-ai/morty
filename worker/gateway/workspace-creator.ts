import * as v from "valibot";
import { hasTenantCreationBindings } from "../infra/allocator-bindings.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { WorkspaceCreationError, type WorkspaceCreator } from "../service/workspace-creator.ts";

const responseSchema = v.object({
    canDelete: v.boolean(),
    id: v.pipe(v.string(), v.startsWith("org_")),
    name: v.pipe(v.string(), v.minLength(1)),
});

export class DurableObjectWorkspaceCreator implements WorkspaceCreator {
    static readonly inject = ["bindings"] as const;
    readonly #bindings: CloudBindings;
    constructor(bindings: CloudBindings) {
        this.#bindings = bindings;
    }
    readonly create: WorkspaceCreator["create"] = async (input, parent) => {
        parent.throwIfAborted();
        if (!hasTenantCreationBindings(this.#bindings)) {
            throw new WorkspaceCreationError("WORKSPACES_UNAVAILABLE");
        }
        const signal = AbortSignal.any([parent, AbortSignal.timeout(20_000)]);
        try {
            const namespace = this.#bindings.TENANT_PLACEMENT_ALLOCATOR;
            const response = await namespace.get(namespace.idFromName(this.#bindings.DEPLOY_ENVIRONMENT)).fetch(
                new Request("https://tenant-placement.internal/create", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        ...input,
                        environment: this.#bindings.DEPLOY_ENVIRONMENT,
                    }),
                    signal,
                }),
            );
            const value: unknown = await response.json();
            signal.throwIfAborted();
            const result = v.safeParse(responseSchema, value);
            if (response.status === 201 && result.success) {
                return result.output;
            }
            const error = v.safeParse(v.object({ error: v.object({ code: v.literal("INVALID_INPUT") }) }), value);
            throw new WorkspaceCreationError(error.success ? "INVALID_INPUT" : "WORKSPACES_UNAVAILABLE");
        } catch (cause) {
            parent.throwIfAborted();
            if (cause instanceof WorkspaceCreationError) {
                throw cause;
            }
            throw new WorkspaceCreationError(signal.aborted ? "WORKSPACES_TIMEOUT" : "WORKSPACES_UNAVAILABLE", {
                cause,
            });
        }
    };
}

export function requestRegion(request: Request): "apac" | "wnam" {
    const context = v.safeParse(v.object({ continent: v.optional(v.string()) }), Reflect.get(request, "cf"));
    return context.success && ["AS", "OC"].includes(context.output.continent ?? "") ? "apac" : "wnam";
}
