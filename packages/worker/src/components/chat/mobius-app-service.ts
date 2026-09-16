import * as v from "valibot";
import type { HttpError } from "../../infra/http-error.ts";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
const credential = v.pipe(v.string(), v.minLength(1), v.maxLength(4096));
const accessTokenSchema = v.pipe(v.object({ accessTokenId: identifier, accessToken: credential }), v.readonly());

export type MobiusAccessToken = v.InferOutput<typeof accessTokenSchema>;

interface MobiusAppMetricsLogger {
    readonly info: (bindings: Readonly<Record<string, unknown>>, message: string) => void;
}

type MobiusAppOperation = "issue-access-token" | "regenerate-access-token" | "revoke-access-token";

export class MobiusAppService {
    readonly #appId: unknown;
    readonly #appSecret: unknown;
    readonly #baseUrl: unknown;
    readonly #forbiddenOrigin: unknown;
    readonly #metrics: MobiusAppMetricsLogger;
    readonly #nowMilliseconds: () => number;
    constructor(configuration: {
        readonly appId: unknown;
        readonly appSecret: unknown;
        readonly baseUrl: unknown;
        readonly forbiddenOrigin: unknown;
        readonly metrics: MobiusAppMetricsLogger;
        readonly nowMilliseconds: () => number;
    }) {
        this.#appId = configuration.appId;
        this.#appSecret = configuration.appSecret;
        this.#baseUrl = configuration.baseUrl;
        this.#forbiddenOrigin = configuration.forbiddenOrigin;
        this.#metrics = configuration.metrics;
        this.#nowMilliseconds = configuration.nowMilliseconds;
    }

    readonly issueAccessToken = async (
        botId: string,
        ownerCredential: string | null,
        signal: AbortSignal,
    ): Promise<MobiusAccessToken> => {
        const headers = new Headers({ "content-type": "application/json" });
        if (ownerCredential !== null) {
            headers.set("authorization", `Bearer ${v.parse(credential, ownerCredential)}`);
        }
        const response = await this.#request(
            "issue-access-token",
            "/mobius/api/v1/access-tokens",
            { method: "POST", headers, body: JSON.stringify({ botId: v.parse(identifier, botId) }) },
            signal,
        );
        if (!response.ok) {
            await response.body?.cancel();
            throw new MobiusAppError("MOBIUS_ACCESS_TOKEN_REJECTED", "Mobius rejected the access-token request.", 502);
        }
        let value: unknown;
        try {
            value = await response.json();
        } catch (cause) {
            throw new MobiusAppError("MOBIUS_INVALID_RESPONSE", "Mobius returned an invalid response.", 502, {
                cause,
            });
        }
        return v.parse(accessTokenSchema, value);
    };

    readonly revokeAccessToken = async (accessTokenId: string, signal: AbortSignal): Promise<void> => {
        const response = await this.#request(
            "revoke-access-token",
            `/mobius/api/v1/access-tokens/${encodeURIComponent(v.parse(identifier, accessTokenId))}`,
            { method: "DELETE" },
            signal,
        );
        if (!response.ok) {
            await response.body?.cancel();
            throw new MobiusAppError(
                "MOBIUS_ACCESS_TOKEN_REVOKE_FAILED",
                "Mobius could not revoke the access token.",
                502,
            );
        }
        await response.body?.cancel();
    };

    readonly regenerateAccessToken = async (accessTokenId: string, signal: AbortSignal): Promise<MobiusAccessToken> => {
        const response = await this.#request(
            "regenerate-access-token",
            `/mobius/api/v1/access-tokens/${encodeURIComponent(v.parse(identifier, accessTokenId))}/regenerate`,
            { method: "POST" },
            signal,
        );
        if (!response.ok) {
            await response.body?.cancel();
            throw new MobiusAppError(
                "MOBIUS_ACCESS_TOKEN_REGENERATION_FAILED",
                "Mobius could not regenerate the access token.",
                502,
            );
        }
        const regenerated = v.parse(accessTokenSchema, await response.json());
        if (regenerated.accessTokenId !== accessTokenId) {
            throw new MobiusAppError("MOBIUS_INVALID_RESPONSE", "Mobius regenerated an unexpected access token.", 502);
        }
        return regenerated;
    };

    readonly #configuration = (): {
        readonly appId: string;
        readonly appSecret: string;
        readonly baseUrl: URL;
    } => {
        try {
            const baseUrl = new URL(v.parse(v.string(), this.#baseUrl));
            if (
                (baseUrl.protocol !== "https:" &&
                    !(
                        baseUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname)
                    )) ||
                baseUrl.username !== "" ||
                baseUrl.password !== "" ||
                baseUrl.pathname !== "/" ||
                baseUrl.search !== "" ||
                baseUrl.hash !== "" ||
                (typeof this.#forbiddenOrigin === "string" && baseUrl.origin === new URL(this.#forbiddenOrigin).origin)
            ) {
                throw new Error("Invalid Mobius URL");
            }
            return {
                appId: v.parse(credential, this.#appId),
                appSecret: v.parse(credential, this.#appSecret),
                baseUrl,
            };
        } catch {
            throw new MobiusAppError("MOBIUS_UNAVAILABLE", "Mobius service is not configured.", 503);
        }
    };

    readonly #request = async (
        operation: MobiusAppOperation,
        path: string,
        init: RequestInit,
        signal: AbortSignal,
    ): Promise<Response> => {
        signal.throwIfAborted();
        const startedAt = this.#nowMilliseconds();
        let outcome: "failure" | "success" = "failure";
        const configuration = this.#configuration();
        const headers = new Headers(init.headers);
        headers.set("x-mobius-app-id", configuration.appId);
        headers.set("x-mobius-app-secret", configuration.appSecret);
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        try {
            const response = await fetch(
                new Request(new URL(path, configuration.baseUrl), {
                    ...init,
                    headers,
                    redirect: "manual",
                    signal: deadline,
                }),
            );
            if (response.status >= 300 && response.status < 400) {
                await response.body?.cancel();
                throw new MobiusAppError("MOBIUS_BAD_GATEWAY", "Mobius returned an unexpected redirect.", 502);
            }
            outcome = response.ok ? "success" : "failure";
            return response;
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof MobiusAppError) {
                throw cause;
            }
            throw new MobiusAppError(
                deadline.aborted ? "MOBIUS_TIMEOUT" : "MOBIUS_BAD_GATEWAY",
                deadline.aborted ? "Mobius did not respond in time." : "Mobius is unavailable.",
                deadline.aborted ? 504 : 502,
                { cause },
            );
        } finally {
            this.#metrics.info(
                {
                    durationMs: this.#nowMilliseconds() - startedAt,
                    event: "performance-metric",
                    metric: "mobius-chat-gateway-request-duration",
                    operation,
                    outcome,
                },
                "Performance metric",
            );
        }
    };
}

export class MobiusAppError extends Error implements HttpError {
    readonly code: string;
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    constructor(
        code: string,
        message: string,
        status: number,
        options?: ErrorOptions,
        headers: Readonly<Record<string, string>> = {},
    ) {
        super(message, options);
        this.code = code;
        this.status = status;
        this.headers = headers;
        this.name = "MobiusAppError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.status,
        headers: this.headers,
    });
}
