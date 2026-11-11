import { Hono } from "hono";
import * as v from "valibot";
import { admitAnonymousCreation } from "../../../gateway/anonymous-creation-admission.ts";
import { computerObject } from "../../../gateway/computer-object-routing.ts";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import { RequestDeadline } from "../../../infra/request-deadline.ts";
import { readJsonBody } from "../../../middleware/body-parser.ts";
import { anonymousCreationKey } from "../entity/computer-bootstrap.ts";
import type { AccountProvisioner } from "../service/account-provisioning-service.ts";
import { computerLocationHint } from "../util/computer-location.ts";

const inputSchema = v.strictObject({
    creationKey: anonymousCreationKey,
    locationHint: v.optional(
        v.picklist(["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"]),
    ),
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

export const anonymousUserRoutes = new Hono<{
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly provisionAccount: AccountProvisioner };
}>().post("/identity/anonymous-users", async (context) => {
    const request = context.req.raw;
    using deadline = new RequestDeadline(request.signal, 45_000);
    const signal = deadline.signal;
    const input = v.parse(inputSchema, await readJsonBody(request));
    signal.throwIfAborted();
    await admitAnonymousCreation(request, context.env);
    signal.throwIfAborted();
    const userId = await userIdFor(input.creationKey);
    const computer = await context.var.provisionAccount(
        userId,
        userId,
        input.locationHint ?? computerLocationHint(request) ?? "apac",
        signal,
    );
    const response = await computerObject(context.env, computer.computerId).fetch(
        new Request("https://computer.internal/__computer/bootstrap", {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal,
            body: JSON.stringify({
                computer: computer,
                userId,
                origin: { kind: "created", creationKey: input.creationKey },
            }),
        }),
    );
    signal.throwIfAborted();
    return response;
});
