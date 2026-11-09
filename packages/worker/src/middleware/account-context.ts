import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { ManagementError } from "../components/management/entity/management-error.ts";
import { platformIdentifier } from "../components/management/entity/platform-project.ts";
import { readProjectCredential } from "../components/management/entity/project-credential.ts";
import { accountBindings } from "../composition/account-bindings.ts";
import { type ApplicationContext, createApplicationDependencies } from "../composition/application-context.ts";
import { routeAccountObject } from "../gateway/account-object-routing.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { readJsonBody } from "./body-parser.ts";

export const cloudAccountContext = createMiddleware<{
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly dependencies: ApplicationContext };
}>(async (context, next) => {
    const request = context.req.raw;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
    const accountId = await cloudAccountId(request);
    const routed = await routeAccountObject(request, context.env, accountId);
    if (routed !== null) {
        return routed;
    }
    const bindings = accountId === null ? context.env : await accountBindings(context.env, accountId, signal);
    context.set("dependencies", createApplicationDependencies(bindings));
    return await next();
});

export async function cloudAccountId(request: Request): Promise<string | null> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/morty/api/accounts/")) {
        const accountId = path.split("/")[4];
        if (accountId === undefined || accountId === "") {
            throw new ManagementError("PROJECT_REQUIRED", "Morty context is required.", 400);
        }
        return v.parse(platformIdentifier, accountId);
    }
    if (path.startsWith("/morty/api/chat/accounts/")) {
        const accountId = path.split("/")[5];
        if (accountId === undefined || accountId === "") {
            throw new ManagementError("PROJECT_REQUIRED", "Morty context is required.", 400);
        }
        return v.parse(platformIdentifier, accountId);
    }
    if (path === "/morty/api/identity/anonymous-users") {
        return null;
    }
    const inputKey = path === "/morty/api/identity/transfers/redeem" ? "code" : null;
    if (request.method === "POST" && inputKey !== null) {
        const input = await readJsonBody(request.clone());
        const parsed = v.safeParse(v.record(v.string(), v.unknown()), input);
        const ticket = parsed.success ? readProjectCredential(parsed.output[inputKey]) : null;
        if (ticket?.kind === "morty_transfer_v1") {
            return ticket.accountId;
        }
    }
    return null;
}
