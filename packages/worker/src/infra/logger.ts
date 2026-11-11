import pino from "pino";
import { serializeDiagnosticError } from "./log-diagnostics.ts";

export const logger = pino({
    base: { service: "morty" },
    browser: { asObject: true, serialize: ["err"] },
    serializers: { err: serializeDiagnosticError },
    level: "info",
});
