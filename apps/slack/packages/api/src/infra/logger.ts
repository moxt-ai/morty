import pino from "pino";

export interface SlackLogger {
    readonly error: (bindings: Readonly<Record<string, unknown>>, message: string) => void;
    readonly info: (bindings: Readonly<Record<string, unknown>>, message: string) => void;
    readonly warn: (bindings: Readonly<Record<string, unknown>>, message: string) => void;
}

const logger = pino({
    base: { service: "mobius-slack" },
    browser: { asObject: true },
    level: "info",
});

function sanitizeBindings(bindings: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    return Object.fromEntries(
        Object.entries(bindings).map(([key, value]) => {
            if (key === "err") {
                return [key, sanitizeError(value)];
            }
            if (/^(?:authorization|botToken|hostToken|token)$/iu.test(key)) {
                return [key, "[Redacted]"];
            }
            return [key, value];
        }),
    );
}

function sanitizeError(error: unknown): Readonly<Record<string, unknown>> {
    if (!(error instanceof Error)) {
        return { type: typeof error };
    }
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return code === undefined ? { name: error.name } : { code, name: error.name };
}

export const slackLogger: SlackLogger = {
    error: (bindings, message) => logger.error(sanitizeBindings(bindings), message),
    info: (bindings, message) => logger.info(sanitizeBindings(bindings), message),
    warn: (bindings, message) => logger.warn(sanitizeBindings(bindings), message),
};
