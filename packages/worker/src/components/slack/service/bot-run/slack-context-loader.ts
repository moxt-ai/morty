import type { SlackMessage } from "../../entity/slack-message";
import type { StoredSlackEventTarget } from "../../storage/slack-event-records";
import type { TenantContext } from "../identity/tenant-context";
import type { ContextLoadType } from "./event-decision";
import type { SlackMessageRenderer } from "./slack-message-renderer";

const MAX_CHANNEL_MESSAGES = 10;

export interface SlackContextRequest {
    readonly target: StoredSlackEventTarget;
    readonly channelId: string;
    readonly currentTs: string;
    readonly loadType: ContextLoadType;
    readonly oldest: string | null;
    readonly threadTs: string | null;
    readonly token: string;
}

export interface SlackLoadedContext {
    readonly contextText: string;
    readonly latestTs: string | null;
    readonly messages: readonly SlackMessage[];
}

export class SlackContextLoader {
    readonly #history: SlackWebApi;
    readonly #renderMessage: SlackMessageRenderer;
    constructor(cx: {
        readonly gateways: { readonly slackWebApi: SlackWebApi };
        readonly services: { readonly slackMessageRenderer: SlackMessageRenderer };
    }) {
        const { slackWebApi: history } = cx.gateways;
        const { slackMessageRenderer: renderMessage } = cx.services;
        this.#history = history;
        this.#renderMessage = renderMessage;
    }

    readonly load = async (
        tenant: TenantContext,
        request: SlackContextRequest,
        signal: AbortSignal,
    ): Promise<SlackLoadedContext> => {
        switch (request.loadType) {
            case "CHANNEL_FULL":
                return await this.#loadChannel(tenant, request, null, "Channel history", signal);
            case "CHANNEL_INCREMENTAL":
                return await this.#loadChannel(tenant, request, request.oldest, "Previous messages", signal);
            case "THREAD_FULL_WITH_CHANNEL":
                return await this.#loadThreadWithChannel(tenant, request, signal);
            case "THREAD_INCREMENTAL":
                return await this.#loadThread(tenant, request, request.oldest, signal);
        }
    };

    readonly #loadChannel = async (
        tenant: TenantContext,
        request: SlackContextRequest,
        oldest: string | null,
        heading: string,
        signal: AbortSignal,
    ): Promise<SlackLoadedContext> => {
        const messages = await this.#history.getChannelHistory(
            {
                channelId: request.channelId,
                latest: request.currentTs,
                limit: MAX_CHANNEL_MESSAGES,
                oldest,
                token: request.token,
            },
            signal,
        );
        return await this.#render(
            tenant,
            request.target,
            messages.filter((message) => message.ts !== request.currentTs),
            heading,
            signal,
        );
    };

    readonly #loadThreadWithChannel = async (
        tenant: TenantContext,
        request: SlackContextRequest,
        signal: AbortSignal,
    ): Promise<SlackLoadedContext> => {
        if (request.threadTs === null) {
            return emptyContext();
        }
        const [channel, thread] = await Promise.all([
            this.#history.getChannelHistory(
                {
                    channelId: request.channelId,
                    latest: request.threadTs,
                    limit: MAX_CHANNEL_MESSAGES,
                    oldest: null,
                    token: request.token,
                },
                signal,
            ),
            this.#history.getThreadHistory(
                {
                    channelId: request.channelId,
                    oldest: null,
                    threadTs: request.threadTs,
                    token: request.token,
                },
                signal,
            ),
        ]);
        const channelContext = await this.#render(tenant, request.target, channel, "Channel history", signal);
        const threadContext = await this.#render(
            tenant,
            request.target,
            thread.filter((message) => message.ts !== request.currentTs),
            "Thread messages",
            signal,
        );
        return {
            contextText: [channelContext.contextText, threadContext.contextText]
                .filter((section) => section.length > 0)
                .join("\n\n"),
            latestTs: latestTimestamp(thread),
            messages: [...channelContext.messages, ...threadContext.messages],
        };
    };

    readonly #loadThread = async (
        tenant: TenantContext,
        request: SlackContextRequest,
        oldest: string | null,
        signal: AbortSignal,
    ): Promise<SlackLoadedContext> => {
        if (request.threadTs === null) {
            return emptyContext();
        }
        const messages = await this.#history.getThreadHistory(
            {
                channelId: request.channelId,
                oldest,
                threadTs: request.threadTs,
                token: request.token,
            },
            signal,
        );
        return await this.#render(
            tenant,
            request.target,
            messages.filter((message) => message.ts !== request.currentTs),
            "Previous messages",
            signal,
        );
    };

    readonly #render = async (
        tenant: TenantContext,
        target: StoredSlackEventTarget,
        messages: readonly SlackMessage[],
        heading: string,
        signal: AbortSignal,
    ): Promise<SlackLoadedContext> => {
        const ordered = [...messages].sort((left, right) => left.ts.localeCompare(right.ts));
        const lines = await Promise.all(
            ordered.map(async (message) => await this.#renderMessage.render(tenant, target, message, signal)),
        );
        return {
            contextText: lines.length === 0 ? "" : `# ${heading}:\n${lines.join("\n")}`,
            latestTs: latestTimestamp(messages),
            messages: ordered,
        };
    };
}

function latestTimestamp(messages: readonly SlackMessage[]): string | null {
    let latest: string | null = null;
    for (const message of messages) {
        if (latest === null || message.ts > latest) {
            latest = message.ts;
        }
    }
    return latest;
}

function emptyContext(): SlackLoadedContext {
    return { contextText: "", latestTs: null, messages: [] };
}

import type { SlackWebApi } from "../../../../gateway/slack-web-gateway";
