import { SlackWebApi } from "../../src/gateway/index";
import type { SlackMessage } from "../../src/service/bot-tools/slack-bot-tool-service";

export class InMemorySlack extends SlackWebApi {
    readonly files = new Map<string, string>();
    override readonly downloadFile = async (_token: string, url: string, signal: AbortSignal): Promise<Response> => {
        signal.throwIfAborted();
        const body = this.files.get(url);
        return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    };
    readonly messages: Array<{
        readonly token: string;
        readonly channelId: string;
        readonly text: string;
        readonly threadTs: string | null;
    }> = [];
    readonly statuses = new Map<string, string>();
    readonly ephemeral: string[] = [];
    readonly oauthCodes = new Map<string, string>([["oauth-code", "client-1"]]);
    channelMessages: readonly SlackMessage[] = [];
    threadMessages: readonly SlackMessage[] = [];
    override readonly postMessage = async (
        token: string,
        channelId: string,
        text: string,
        threadTs: string | null,
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        this.messages.push({ token, channelId, text, threadTs });
        return { channelId, ts: `${this.messages.length}.0` };
    };
    override readonly sendMessage = this.postMessage;
    override readonly sendDirectMessage = async (token: string, userId: string, text: string, signal: AbortSignal) =>
        await this.postMessage(token, `D:${userId}`, text, null, signal);
    override readonly getChannelHistory = async (
        _input: Parameters<SlackWebApi["getChannelHistory"]>[0],
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        return this.channelMessages;
    };
    override readonly getThreadHistory = async (
        _input: Parameters<SlackWebApi["getThreadHistory"]>[0],
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        return this.threadMessages;
    };
    override readonly getThreadMessages = async (
        _token: string,
        _channel: string,
        _thread: string,
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        return this.threadMessages;
    };
    override readonly getUserName = async (_token: string, user: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        return user;
    };
    override readonly getBotAppId = async (_token: string, bot: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        return bot === "B_SOURCE" ? "A_SOURCE" : null;
    };
    override readonly setThreadStatus = async (
        _token: string,
        channel: string,
        thread: string,
        status: string,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        this.statuses.set(`${channel}:${thread}`, status);
    };
    override readonly postEphemeral = async (
        _token: string,
        _channel: string,
        _user: string,
        text: string,
        _thread: string | null,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        this.ephemeral.push(text);
    };
    override readonly exchangeCode = async (input: Parameters<SlackWebApi["exchangeCode"]>[0], signal: AbortSignal) => {
        signal.throwIfAborted();
        if (this.oauthCodes.get(input.code) !== input.clientId || input.clientSecret !== "client-secret") {
            throw new Error("Invalid OAuth credentials");
        }
        this.oauthCodes.delete(input.code);
        return {
            accessToken: "xoxb-token",
            authedUserId: "U_INSTALLER",
            botUserId: "U_BOT",
            teamId: "T123",
            teamName: "Example",
        };
    };
}
