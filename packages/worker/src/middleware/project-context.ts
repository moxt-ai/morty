import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { readProjectCredential } from "../components/management/entity/project-credential.ts";
import { type ApplicationContext, createApplicationDependencies } from "../composition/application-context.ts";
import { projectBindings } from "../composition/chat-shards.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { json } from "../infra/http.ts";

export const cloudProjectContext = createMiddleware<{
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly dependencies: ApplicationContext };
}>(async (context, next) => {
    const request = context.req.raw;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
    const projectId = await cloudProjectId(request);
    const bindings = projectId === null ? context.env : await projectBindings(context.env, projectId, signal);
    context.set("dependencies", createApplicationDependencies(bindings));
    await next();
});

export const slackProjectContext = createMiddleware<{
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly projectBindings: CloudBindings };
}>(async (context, next) => {
    const projectId = context.req.header("X-Mobius-Project-Id") ?? context.req.query("projectId");
    if (projectId === undefined) {
        return json({ error: { code: "PROJECT_REQUIRED", message: "Project context is required." } }, 400);
    }
    const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(20000)]);
    context.set("projectBindings", await projectBindings(context.env, projectId, signal));
    return await next();
});

async function cloudProjectId(request: Request): Promise<string | null> {
    const path = new URL(request.url).pathname;
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
        const input: unknown = await request.clone().json();
        const parsed = v.safeParse(v.record(v.string(), v.unknown()), input);
        const ticket = parsed.success ? readProjectCredential(parsed.output[inputKey]) : null;
        const expectedKind = inputKey === "code" ? "mobius_transfer_v2" : "mobius_pair_v2";
        if (ticket?.kind === expectedKind) {
            return ticket.projectId;
        }
    }
    return request.headers.get("X-Mobius-Project-Id");
}
