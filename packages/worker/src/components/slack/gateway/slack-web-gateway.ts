import * as v from "valibot";
import { urlSchema } from "../infra/url-schema";
import type { SlackMessage } from "../service/bot-tools/slack-bot-tool-service";
import type { SlackOAuthInstallation } from "../service/installation/slack-installation-service";

const API_BASE_URL = "https://slack.com/api";
const REQUEST_TIMEOUT_MILLISECONDS = 15_000;

const slackErrorSchema = v.object({
    error: v.optional(v.string()),
    ok: v.literal(false),
});

const oauthResponseSchema = v.object({
    access_token: v.pipe(v.string(), v.minLength(1)),
    app_id: v.pipe(v.string(), v.minLength(1)),
    authed_user: v.optional(v.object({ id: v.pipe(v.string(), v.minLength(1)) })),
    bot_user_id: v.pipe(v.string(), v.minLength(1)),
    ok: v.literal(true),
    team: v.object({ id: v.pipe(v.string(), v.minLength(1)), name: v.optional(v.string()) }),
});

const postMessageResponseSchema = v.object({
    channel: v.pipe(v.string(), v.minLength(1)),
    ok: v.literal(true),
    ts: v.pipe(v.string(), v.minLength(1)),
});

const openConversationResponseSchema = v.object({
    channel: v.object({ id: v.pipe(v.string(), v.minLength(1)) }),
    ok: v.literal(true),
});

const fileSchema = v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    mimetype: v.nullish(v.string()),
    name: v.nullish(v.string()),
    size: v.nullish(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
    url_private: v.nullish(urlSchema),
});

const messageSchema = v.object({
    bot_id: v.nullish(v.string()),
    files: v.nullish(v.array(fileSchema)),
    text: v.nullish(v.string()),
    thread_ts: v.nullish(v.string()),
    ts: v.pipe(v.string(), v.minLength(1)),
    user: v.nullish(v.string()),
});

const historyResponseSchema = v.object({
    messages: v.optional(v.array(messageSchema)),
    ok: v.literal(true),
});

const channelSchema = v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    is_member: v.optional(v.boolean()),
    name: v.pipe(v.string(), v.minLength(1)),
});

const channelsResponseSchema = v.object({
    channels: v.optional(v.array(channelSchema)),
    ok: v.literal(true),
    response_metadata: v.optional(v.object({ next_cursor: v.optional(v.string()) })),
});

const basicResponseSchema = v.object({ ok: v.literal(true) });

const botInfoResponseSchema = v.object({
    bot: v.object({ app_id: v.pipe(v.string(), v.minLength(1)) }),
    ok: v.literal(true),
});

const userInfoResponseSchema = v.object({
    ok: v.literal(true),
    user: v.object({
        id: v.pipe(v.string(), v.minLength(1)),
        name: v.optional(v.string()),
        profile: v.optional(
            v.object({
                display_name: v.optional(v.string()),
                real_name: v.optional(v.string()),
            }),
        ),
    }),
});

const manifestCreateResponseSchema = v.object({
    app_id: v.pipe(v.string(), v.minLength(1)),
    credentials: v.object({
        client_id: v.pipe(v.string(), v.minLength(1)),
        client_secret: v.pipe(v.string(), v.minLength(1)),
        signing_secret: v.pipe(v.string(), v.minLength(1)),
    }),
    ok: v.literal(true),
});

const tokenRotateResponseSchema = v.object({
    exp: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
    ok: v.literal(true),
    refresh_token: v.pipe(v.string(), v.minLength(1)),
    token: v.pipe(v.string(), v.minLength(1)),
});

class SlackWebApiError extends Error {
    readonly code: "INVALID_RESPONSE" | "SLACK_API_ERROR" | "SLACK_HTTP_ERROR";
    readonly slackCode: string | null;

    constructor(
        code: "INVALID_RESPONSE" | "SLACK_API_ERROR" | "SLACK_HTTP_ERROR",
        message: string,
        slackCode: string | null = null,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "SlackWebApiError";
        this.code = code;
        this.slackCode = slackCode;
    }
}

export class SlackWebApi {
    readonly exchangeCode = async (
        input: {
            readonly clientId: string;
            readonly clientSecret: string;
            readonly code: string;
            readonly redirectUri: string;
        },
        signal: AbortSignal,
    ): Promise<SlackOAuthInstallation> => {
        const value = v.parse(
            oauthResponseSchema,
            await this.#form(
                "oauth.v2.access",
                {
                    client_id: input.clientId,
                    client_secret: input.clientSecret,
                    code: input.code,
                    redirect_uri: input.redirectUri,
                },
                null,
                signal,
            ),
        );
        return {
            accessToken: value.access_token,
            authedUserId: value.authed_user?.id ?? null,
            botUserId: value.bot_user_id,
            teamId: value.team.id,
            teamName: value.team.name ?? null,
        };
    };

    readonly postMessage = async (
        token: string,
        channelId: string,
        text: string,
        threadTs: string | null,
        signal: AbortSignal,
    ): Promise<{ readonly channelId: string; readonly ts: string }> => {
        const result = v.parse(
            postMessageResponseSchema,
            await this.#json(
                "chat.postMessage",
                {
                    channel: channelId,
                    text,
                    ...(threadTs === null ? {} : { thread_ts: threadTs }),
                },
                token,
                signal,
            ),
        );
        return { channelId: result.channel, ts: result.ts };
    };

    readonly sendMessage = this.postMessage;

    readonly sendDirectMessage = async (
        token: string,
        slackUserId: string,
        text: string,
        signal: AbortSignal,
    ): Promise<{ readonly channelId: string; readonly ts: string }> => {
        const opened = v.parse(
            openConversationResponseSchema,
            await this.#json("conversations.open", { users: slackUserId }, token, signal),
        );
        return await this.postMessage(token, opened.channel.id, text, null, signal);
    };

    readonly getChannelMessages = async (
        token: string,
        channelId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<readonly SlackMessage[]> =>
        await this.getChannelHistory(
            {
                channelId,
                latest: `${Math.floor(Date.now() / 1_000) + 1}.000000`,
                limit,
                oldest: null,
                token,
            },
            signal,
        );

    readonly getChannelHistory = async (
        input: {
            readonly channelId: string;
            readonly latest: string;
            readonly limit: number;
            readonly oldest: string | null;
            readonly token: string;
        },
        signal: AbortSignal,
    ): Promise<readonly SlackMessage[]> => {
        const query = new URLSearchParams({
            channel: input.channelId,
            inclusive: "false",
            latest: input.latest,
            limit: String(input.limit),
        });
        if (input.oldest !== null) {
            query.set("oldest", input.oldest);
        }
        const value = v.parse(
            historyResponseSchema,
            await this.#get("conversations.history", query, input.token, signal),
        );
        return (value.messages ?? []).map(toSlackMessage);
    };

    readonly getThreadMessages = async (
        token: string,
        channelId: string,
        threadTs: string,
        signal: AbortSignal,
    ): Promise<readonly SlackMessage[]> =>
        await this.getThreadHistory({ channelId, oldest: null, threadTs, token }, signal);

    readonly getThreadHistory = async (
        input: {
            readonly channelId: string;
            readonly oldest: string | null;
            readonly threadTs: string;
            readonly token: string;
        },
        signal: AbortSignal,
    ): Promise<readonly SlackMessage[]> => {
        const query = new URLSearchParams({
            channel: input.channelId,
            inclusive: "false",
            ts: input.threadTs,
        });
        if (input.oldest !== null) {
            query.set("oldest", input.oldest);
        }
        const value = v.parse(
            historyResponseSchema,
            await this.#get("conversations.replies", query, input.token, signal),
        );
        return (value.messages ?? []).map(toSlackMessage);
    };

    readonly listChannels = async (
        token: string,
        signal: AbortSignal,
    ): Promise<readonly { readonly id: string; readonly name: string }[]> => {
        const channels: Array<{ readonly id: string; readonly name: string }> = [];
        let cursor = "";
        do {
            const query = new URLSearchParams({
                exclude_archived: "true",
                limit: "200",
                types: "public_channel,private_channel",
            });
            if (cursor.length > 0) {
                query.set("cursor", cursor);
            }
            const value = v.parse(channelsResponseSchema, await this.#get("conversations.list", query, token, signal));
            channels.push(
                ...(value.channels ?? [])
                    .filter((channel) => channel.is_member === true)
                    .map((channel) => ({ id: channel.id, name: channel.name })),
            );
            cursor = value.response_metadata?.next_cursor ?? "";
        } while (cursor.length > 0);
        return channels;
    };

    readonly addReaction = async (
        token: string,
        channelId: string,
        messageTs: string,
        name: string,
        signal: AbortSignal,
    ): Promise<void> => {
        v.parse(
            basicResponseSchema,
            await this.#json("reactions.add", { channel: channelId, name, timestamp: messageTs }, token, signal),
        );
    };

    readonly removeReaction = async (
        token: string,
        channelId: string,
        messageTs: string,
        name: string,
        signal: AbortSignal,
    ): Promise<void> => {
        v.parse(
            basicResponseSchema,
            await this.#json("reactions.remove", { channel: channelId, name, timestamp: messageTs }, token, signal),
        );
    };

    readonly postEphemeral = async (
        token: string,
        channelId: string,
        slackUserId: string,
        text: string,
        threadTs: string | null,
        signal: AbortSignal,
    ): Promise<void> => {
        v.parse(
            basicResponseSchema,
            await this.#json(
                "chat.postEphemeral",
                {
                    channel: channelId,
                    text,
                    user: slackUserId,
                    ...(threadTs === null ? {} : { thread_ts: threadTs }),
                },
                token,
                signal,
            ),
        );
    };

    readonly setThreadStatus = async (
        token: string,
        channelId: string,
        threadTs: string,
        status: string,
        signal: AbortSignal,
    ): Promise<void> => {
        v.parse(
            basicResponseSchema,
            await this.#json(
                "assistant.threads.setStatus",
                { channel_id: channelId, status, thread_ts: threadTs },
                token,
                signal,
            ),
        );
    };

    readonly getBotAppId = async (token: string, botId: string, signal: AbortSignal): Promise<string | null> => {
        try {
            const value = v.parse(
                botInfoResponseSchema,
                await this.#get("bots.info", new URLSearchParams({ bot: botId }), token, signal),
            );
            return value.bot.app_id;
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof SlackWebApiError) {
                return null;
            }
            throw error;
        }
    };

    readonly getUserName = async (token: string, userId: string, signal: AbortSignal): Promise<string> => {
        const value = v.parse(
            userInfoResponseSchema,
            await this.#get("users.info", new URLSearchParams({ user: userId }), token, signal),
        );
        return value.user.profile?.display_name || value.user.profile?.real_name || value.user.name || value.user.id;
    };

    readonly createManifestApp = async (
        token: string,
        manifest: unknown,
        signal: AbortSignal,
    ): Promise<{
        readonly clientId: string;
        readonly clientSecret: string;
        readonly signingSecret: string;
        readonly slackAppId: string;
    }> => {
        const value = v.parse(
            manifestCreateResponseSchema,
            await this.#json("apps.manifest.create", { manifest: JSON.stringify(manifest) }, token, signal),
        );
        return {
            clientId: value.credentials.client_id,
            clientSecret: value.credentials.client_secret,
            signingSecret: value.credentials.signing_secret,
            slackAppId: value.app_id,
        };
    };

    readonly deleteManifestApp = async (token: string, slackAppId: string, signal: AbortSignal): Promise<void> => {
        v.parse(basicResponseSchema, await this.#json("apps.manifest.delete", { app_id: slackAppId }, token, signal));
    };

    readonly rotateConfigToken = async (
        refreshToken: string,
        signal: AbortSignal,
    ): Promise<{
        readonly accessToken: string;
        readonly expiresAt: number;
        readonly refreshToken: string;
    }> => {
        const value = v.parse(
            tokenRotateResponseSchema,
            await this.#form(
                "tooling.tokens.rotate",
                {
                    refresh_token: refreshToken,
                },
                null,
                signal,
            ),
        );
        return {
            accessToken: value.token,
            expiresAt: (value.exp ?? Math.floor(Date.now() / 1_000) + 43_200) * 1_000,
            refreshToken: value.refresh_token,
        };
    };

    readonly downloadFile = async (token: string, url: string, signal: AbortSignal): Promise<Response> => {
        const target = new URL(url);
        if (target.protocol !== "https:" || !target.hostname.endsWith("slack.com")) {
            throw new SlackWebApiError("SLACK_HTTP_ERROR", "Slack file URL is not allowed");
        }
        return await timedFetch(
            new Request(target, {
                headers: { Authorization: `Bearer ${token}` },
            }),
            signal,
        );
    };

    readonly #get = async (
        method: string,
        query: URLSearchParams,
        token: string,
        signal: AbortSignal,
    ): Promise<unknown> => {
        const response = await timedFetch(
            new Request(`${API_BASE_URL}/${method}?${query.toString()}`, {
                headers: { Authorization: `Bearer ${token}` },
            }),
            signal,
        );
        return await decodeResponse(method, response);
    };

    readonly #json = async (method: string, body: unknown, token: string, signal: AbortSignal): Promise<unknown> => {
        const response = await timedFetch(
            new Request(`${API_BASE_URL}/${method}`, {
                body: JSON.stringify(body),
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                method: "POST",
            }),
            signal,
        );
        return await decodeResponse(method, response);
    };

    readonly #form = async (
        method: string,
        body: Readonly<Record<string, string>>,
        token: string | null,
        signal: AbortSignal,
    ): Promise<unknown> => {
        const headers = new Headers({
            "Content-Type": "application/x-www-form-urlencoded",
        });
        if (token !== null) {
            headers.set("Authorization", `Bearer ${token}`);
        }
        const response = await timedFetch(
            new Request(`${API_BASE_URL}/${method}`, {
                body: new URLSearchParams(body),
                headers,
                method: "POST",
            }),
            signal,
        );
        return await decodeResponse(method, response);
    };
}

function toSlackMessage(value: v.InferOutput<typeof messageSchema>): SlackMessage {
    return {
        botId: value.bot_id ?? null,
        files: (value.files ?? []).map((file) => ({
            id: file.id,
            mimetype: file.mimetype ?? null,
            name: file.name ?? null,
            size: file.size ?? null,
            urlPrivate: file.url_private ?? null,
        })),
        text: value.text ?? "",
        threadTs: value.thread_ts ?? null,
        ts: value.ts,
        userId: value.user ?? null,
    };
}

async function decodeResponse(method: string, response: Response): Promise<unknown> {
    if (!response.ok) {
        throw new SlackWebApiError("SLACK_HTTP_ERROR", `Slack ${method} request failed`);
    }
    let value: unknown;
    try {
        value = await response.json();
    } catch (error) {
        throw new SlackWebApiError("INVALID_RESPONSE", `Slack ${method} returned invalid JSON`, null, { cause: error });
    }
    const slackError = v.safeParse(slackErrorSchema, value);
    if (slackError.success) {
        throw new SlackWebApiError(
            "SLACK_API_ERROR",
            `Slack ${method} rejected the request`,
            slackError.output.error ?? "unknown_error",
        );
    }
    return value;
}

async function timedFetch(request: Request, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS);
    return await fetch(request, {
        signal: AbortSignal.any([signal, timeoutSignal]),
    });
}
