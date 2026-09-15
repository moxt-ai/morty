import { Hono } from "hono";
import pino from "pino";
import { PlatformProjectGateway } from "../../src/gateway/platform-project-gateway.ts";
import type { CloudBindings } from "../../src/infra/cloud-bindings.ts";
import { errorMiddleware, rethrowHttpError } from "../../src/middleware/error-middleware.ts";

const logger = pino({ browser: { asObject: true } });
export default new Hono<{ readonly Bindings: CloudBindings }>()
    .onError(rethrowHttpError)
    .use(
        "*",
        errorMiddleware(() => logger),
    )
    .all("*", async (context) => {
        const placement = await new PlatformProjectGateway(context.env).storagePlacement(
            new URL(context.req.url).pathname.slice(1),
            context.req.raw.signal,
        );
        return Response.json(placement);
    });
