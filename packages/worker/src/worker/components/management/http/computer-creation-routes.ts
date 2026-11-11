import { Hono } from "hono";
import * as v from "valibot";
import type { AccountProvisioner } from "../../../../contracts/account-provisioning.ts";
import type { CloudBindings } from "../../../../contracts/cloud-bindings.ts";
import { anonymousCreationKey } from "../../../../contracts/computer-bootstrap.ts";
import { projectLocationHint } from "../../../../contracts/project-location.ts";
import { readJsonBody } from "../../../../http/body-parser.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { admitAnonymousCreation } from "../../../gateway/anonymous-creation-admission.ts";
import { computerObject } from "../../../gateway/computer-object-routing.ts";

const inputSchema = v.strictObject({
    creationKey: anonymousCreationKey,
});

/** The public user ID never reveals its client-held creation key. */
async function userIdFor(key: string): Promise<string> {
    const digest = new Uint8Array(
        await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify(["morty-anonymous-user-v1", key])),
        ),
    );
    const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `usr_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const computerCreationRoutes = new Hono<{
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly provisionAccount: AccountProvisioner };
}>().post("/computers", async (context) => {
    const request = context.req.raw;
    using deadline = new RequestDeadline(request.signal, 45_000);
    const signal = deadline.signal;
    const input = v.parse(inputSchema, await readJsonBody(request));
    signal.throwIfAborted();
    await admitAnonymousCreation(request, context.env);
    signal.throwIfAborted();
    const userId = await userIdFor(input.creationKey);
    const project = await context.var.provisionAccount(
        userId,
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
                userId,
                origin: { kind: "created", creationKey: input.creationKey },
            }),
        }),
    );
    signal.throwIfAborted();
    return response;
});
