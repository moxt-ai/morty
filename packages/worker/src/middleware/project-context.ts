import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { ManagementError } from "../components/management/entity/management-error.ts";
import { platformIdentifier } from "../components/management/entity/platform-project.ts";
import { readProjectCredential } from "../components/management/entity/project-credential.ts";
import { type ApplicationContext, createApplicationDependencies } from "../composition/application-context.ts";
import { projectBindings } from "../composition/project-bindings.ts";
import { routeProjectObject } from "../gateway/project-object-routing.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { readJsonBody } from "./body-parser.ts";

export const cloudProjectContext = createMiddleware<{
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly dependencies: ApplicationContext };
}>(async (context, next) => {
    const request = context.req.raw;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
    const projectId = await cloudProjectId(request);
    const routed = await routeProjectObject(request, context.env, projectId);
    if (routed !== null) {
        return routed;
    }
    const bindings = projectId === null ? context.env : await projectBindings(context.env, projectId, signal);
    context.set("dependencies", createApplicationDependencies(bindings));
    return await next();
});

export const slackProjectContext = createMiddleware<{
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly projectBindings: CloudBindings };
}>(async (context, next) => {
    const projectId = context.req.query("projectId");
    if (projectId === undefined) {
        throw new ManagementError("PROJECT_REQUIRED", "Workspace context is required.", 400);
    }
    const routed = await routeProjectObject(context.req.raw, context.env, projectId);
    if (routed !== null) {
        return routed;
    }
    const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(20000)]);
    context.set("projectBindings", await projectBindings(context.env, projectId, signal));
    return await next();
});

export async function cloudProjectId(request: Request): Promise<string | null> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/mobius-cloud/api/projects/")) {
        const projectId = path.split("/")[4];
        if (projectId === undefined || projectId === "") {
            throw new ManagementError("PROJECT_REQUIRED", "Workspace context is required.", 400);
        }
        return v.parse(platformIdentifier, projectId);
    }
    if (path.startsWith("/mobius-cloud/api/chat/projects/")) {
        const projectId = path.split("/")[5];
        if (projectId === undefined || projectId === "") {
            throw new ManagementError("PROJECT_REQUIRED", "Workspace context is required.", 400);
        }
        return v.parse(platformIdentifier, projectId);
    }
    if (path === "/mobius-cloud/api/identity/anonymous-users") {
        return null;
    }
    const inputKey =
        path === "/mobius-cloud/api/identity/transfers/redeem"
            ? "code"
            : path === "/mobius-cloud/api/identity/pairings/redeem"
              ? "token"
              : null;
    if (request.method === "POST" && inputKey !== null) {
        const input = await readJsonBody(request.clone());
        const parsed = v.safeParse(v.record(v.string(), v.unknown()), input);
        const ticket = parsed.success ? readProjectCredential(parsed.output[inputKey]) : null;
        const expectedKind = inputKey === "code" ? "mobius_transfer_v2" : "mobius_pair_v2";
        if (ticket?.kind === expectedKind) {
            return ticket.projectId;
        }
    }
    return null;
}
