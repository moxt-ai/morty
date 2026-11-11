import type { MiddlewareHandler } from "hono";
import { PairingDirectoryError } from "../components/management/entity/pairing.ts";
import type { RelayHttpEnvironment } from "../composition/relay-protocol-environment.ts";
import { requestTimeoutMiddleware } from "./request-timeout-middleware.ts";

export function pairingTimeoutMiddleware(message: string): MiddlewareHandler<RelayHttpEnvironment> {
    return requestTimeoutMiddleware<RelayHttpEnvironment>(
        15_000,
        (cause) => new PairingDirectoryError("pairing_timeout", message, { cause }),
    );
}
