import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import type { AccountProvisioner } from "../../../../contracts/account-provisioning.ts";
import type { CloudBindings } from "../../../../contracts/cloud-bindings.ts";
import { anonymousCreationKey } from "../../../../contracts/computer-bootstrap.ts";
import { projectLocationHint } from "../../../../contracts/project-location.ts";
import { readJsonBody } from "../../../../http/body-parser.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { accountProvisioner } from "../../../gateway/account-provisioning.ts";
import { admitAnonymousCreation } from "../../../gateway/anonymous-creation-admission.ts";
import { computerObject } from "../../../gateway/computer-object-routing.ts";

const inputSchema = v.strictObject({
    creationKey: anonymousCreationKey,
});

export const computerCreationRoutes = new Hono<{
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly provisionAccount: AccountProvisioner };
}>().post(
    "/computers",
    bodyLimit({ maxSize: 3 * 1_024 * 1_024 }),
    async (context, next) => {
        context.set("provisionAccount", accountProvisioner(context.env));
        await next();
    },
    async (context) => {
        const request = context.req.raw;
        using deadline = new RequestDeadline(request.signal, 45_000);
        const signal = deadline.signal;
        const input = v.parse(inputSchema, await readJsonBody(request));
        signal.throwIfAborted();
        await admitAnonymousCreation(request, context.env);
        signal.throwIfAborted();
        const project = await context.var.provisionAccount(
            crypto.randomUUID(),
            projectLocationHint(request) ?? "apac",
            signal,
        );
        const response = await computerObject(context.env, project.computerId).fetch(
            new Request("https://computer.internal/__computer/bootstrap", {
                method: "POST",
                headers: { "content-type": "application/json" },
                signal,
                body: JSON.stringify({
                    computer: project,
                    origin: { kind: "created", creationKey: input.creationKey },
                }),
            }),
        );
        signal.throwIfAborted();
        return response;
    },
);
