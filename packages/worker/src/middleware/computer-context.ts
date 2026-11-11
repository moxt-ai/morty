import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import type { ComputerBackendService } from "../../../relay/src/service/computer-backend-service.ts";
import { readComputerCredential } from "../components/management/entity/computer-credential.ts";
import { relayIdentifier } from "../components/management/entity/computer-management.ts";
import { ManagementError } from "../components/management/entity/management-error.ts";
import { type ApplicationContext, createApplicationDependencies } from "../composition/application-context.ts";
import { computerBindings } from "../composition/computer-bindings.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { RequestDeadline } from "../infra/request-deadline.ts";
import { readJsonBody } from "./body-parser.ts";

export const cloudComputerContext = (computer: ComputerBackendService) =>
    createMiddleware<{
        readonly Bindings: CloudBindings;
        readonly Variables: { readonly dependencies: ApplicationContext };
    }>(async (context, next) => {
        const request = context.req.raw;
        using deadline = new RequestDeadline(request.signal, 20000);
        const signal = deadline.signal;
        const requestedId = context.req.param("computerId");
        if (requestedId !== undefined && requestedId !== computer.computerId) {
            throw new ManagementError("PROJECT_CONTEXT_MISMATCH", "The Morty context is invalid.", 400);
        }
        const bindings = await computerBindings(context.env, computer.computerId, signal);
        context.set("dependencies", createApplicationDependencies(bindings, computer));
        return await next();
    });

export async function cloudComputerId(request: Request): Promise<string | null> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/morty/api/computers/")) {
        const computerId = path.split("/")[4];
        if (computerId === undefined || computerId === "") {
            throw new ManagementError("PROJECT_REQUIRED", "Morty context is required.", 400);
        }
        return v.parse(relayIdentifier, computerId);
    }
    if (path.startsWith("/morty/api/chat/computers/")) {
        const computerId = path.split("/")[5];
        if (computerId === undefined || computerId === "") {
            throw new ManagementError("PROJECT_REQUIRED", "Morty context is required.", 400);
        }
        return v.parse(relayIdentifier, computerId);
    }
    if (path === "/morty/api/identity/anonymous-users") {
        return null;
    }
    const inputKey = path === "/morty/api/identity/transfers/redeem" ? "code" : null;
    if (request.method === "POST" && inputKey !== null) {
        const input = await readJsonBody(request.clone());
        const parsed = v.safeParse(v.record(v.string(), v.unknown()), input);
        const ticket = parsed.success ? readComputerCredential(parsed.output[inputKey]) : null;
        if (ticket?.kind === "morty_transfer_v1") {
            return ticket.computerId;
        }
    }
    return null;
}
