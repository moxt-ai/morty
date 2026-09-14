import { PlatformProjectGateway } from "../../src/gateway/platform-project-gateway.ts";
import { applicationErrorResponse } from "../../src/infra/application-error.ts";
import type { CloudBindings } from "../../src/infra/cloud-bindings.ts";

export default {
    async fetch(request: Request, bindings: CloudBindings) {
        try {
            const placement = await new PlatformProjectGateway(bindings).storagePlacement(
                new URL(request.url).pathname.slice(1),
                request.signal,
            );
            return Response.json(placement);
        } catch (error) {
            if (!(error instanceof Error)) {
                throw error;
            }
            return applicationErrorResponse(error, pino({ browser: { asObject: true } }));
        }
    },
};

import pino from "pino";
