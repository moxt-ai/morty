import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { computerBootstrap } from "./components/management/entity/computer-bootstrap.ts";
import { createApplicationDependencies } from "./composition/application-context.ts";
import { cloudRoutes } from "./composition/cloud-http.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";
import { RequestError } from "./infra/request-error.ts";
import { errorHandler } from "./middleware/error-middleware.ts";

const MAXIMUM_REQUEST_BODY_BYTES = 3 * 1_024 * 1_024;

const notFound = (): never => {
    throw new RequestError("NOT_FOUND", "Not found.", 404);
};

async function bootstrapProject(request: Request, bindings: CloudBindings): Promise<Response> {
    const computerId = bindings.CHAT_COMPUTER_ID;
    if (computerId === undefined) {
        return notFound();
    }
    const input: unknown = await request.json();
    const parsed = v.parse(computerBootstrap, input);
    if (parsed.computer.computerId !== computerId) {
        throw new RequestError("PROJECT_CONTEXT_MISMATCH", "The Morty context is invalid.", 400);
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
    const dependencies = createApplicationDependencies(bindings);
    return new Response(
        JSON.stringify(
            await dependencies.services.management.initializeAnonymousUser(
                parsed.userId,
                parsed.computer,
                signal,
                parsed.origin,
            ),
        ),
        {
            headers: { "Cache-Control": "no-store", "content-type": "application/json" },
            status: 201,
        },
    );
}

export const computerApplication: Hono<{ readonly Bindings: CloudBindings }> = new Hono<{
    readonly Bindings: CloudBindings;
}>()
    .onError(
        errorHandler<{ readonly Bindings: CloudBindings }>(
            (context) => createApplicationDependencies(context.env).logger,
        ),
    )
    .use("/morty/api/*", bodyLimit({ maxSize: MAXIMUM_REQUEST_BODY_BYTES }))
    .post("/__computer/bootstrap", (context) => bootstrapProject(context.req.raw, context.env))
    .route("/morty/api", cloudRoutes)
    .notFound(notFound);
