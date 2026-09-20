import * as v from "valibot";

const TOKEN_TTL_MILLISECONDS = 10 * 60 * 1_000;
const encoder = new TextEncoder();

const oauthStateSchema = v.pipe(
    v.object({
        botId: v.pipe(v.string(), v.minLength(1)),
        expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        humanId: v.pipe(v.string(), v.minLength(1)),
        kind: v.literal("slack-oauth"),
        nonce: v.pipe(v.string(), v.minLength(1)),
        tenantId: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

const tokenEnvelopeSchema = v.pipe(
    v.object({
        payload: v.pipe(v.string(), v.minLength(1)),
        signature: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
        version: v.literal(1),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

export type SlackOAuthState = v.InferOutput<typeof oauthStateSchema>;

import type { ErrorToResponse } from "../../infra/util/error-to-response";

class SlackTokenError extends Error implements ErrorToResponse {
    readonly toResponse = (): Response =>
        Response.json({ error: { code: this.code, message: this.message } }, { status: 400 });
    readonly code: "INVALID_SLACK_TOKEN" | "SLACK_TOKEN_EXPIRED";

    constructor(code: "INVALID_SLACK_TOKEN" | "SLACK_TOKEN_EXPIRED", message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "SlackTokenError";
        this.code = code;
    }
}

import type { ClockService } from "./clock-service";

export class SlackTokenService {
    readonly #clock: ClockService;
    readonly #createNonce: () => string;
    readonly #signingKey: string;
    constructor(cx: {
        readonly utilities: { readonly clock: ClockService; readonly createNonce: () => string };
        readonly config: { readonly signingKey: string };
    }) {
        const { clock, createNonce } = cx.utilities;
        const { signingKey } = cx.config;
        this.#clock = clock;
        this.#createNonce = createNonce;
        this.#signingKey = signingKey;
    }

    readonly issueOAuthState = async (
        input: {
            readonly botId: string;
            readonly humanId: string;
            readonly tenantId: string;
        },
        signal: AbortSignal,
    ): Promise<string> =>
        await this.#issue(
            {
                ...input,
                expiresAt: this.#clock.nowEpochMilliseconds() + TOKEN_TTL_MILLISECONDS,
                kind: "slack-oauth",
                nonce: this.#createNonce(),
            },
            signal,
        );

    readonly readOAuthState = async (token: string, signal: AbortSignal): Promise<SlackOAuthState> => {
        const value = v.parse(oauthStateSchema, await this.#verify(token, signal));
        this.#assertNotExpired(value.expiresAt);
        return value;
    };

    readonly #issue = async (value: SlackOAuthState, signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        const payload = encodeBase64Url(JSON.stringify(value));
        const signature = await sign(this.#signingKey, payload);
        signal.throwIfAborted();
        return encodeBase64Url(JSON.stringify({ payload, signature, version: 1 }));
    };

    readonly #verify = async (token: string, signal: AbortSignal): Promise<unknown> => {
        signal.throwIfAborted();
        try {
            const envelope = v.parse(tokenEnvelopeSchema, JSON.parse(decodeBase64Url(token)));
            const expected = await sign(this.#signingKey, envelope.payload);
            signal.throwIfAborted();
            if (!constantTimeEqual(expected, envelope.signature)) {
                throw new SlackTokenError("INVALID_SLACK_TOKEN", "Slack token is invalid");
            }
            return JSON.parse(decodeBase64Url(envelope.payload));
        } catch (error) {
            if (error instanceof SlackTokenError) {
                throw error;
            }
            throw new SlackTokenError("INVALID_SLACK_TOKEN", "Slack token is invalid", { cause: error });
        }
    };

    readonly #assertNotExpired = (expiresAt: number): void => {
        if (this.#clock.nowEpochMilliseconds() > expiresAt) {
            throw new SlackTokenError("SLACK_TOKEN_EXPIRED", "Slack token has expired");
        }
    };
}

async function sign(keyValue: string, value: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(keyValue),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
    );
    const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(expected: string, received: string): boolean {
    if (expected.length !== received.length) {
        return false;
    }
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
        difference |= expected.charCodeAt(index) ^ received.charCodeAt(index);
    }
    return difference === 0;
}

function encodeBase64Url(value: string): string {
    const bytes = encoder.encode(value);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
    const standard = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
