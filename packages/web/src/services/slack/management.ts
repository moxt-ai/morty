import { useMemo } from "react";
import * as v from "valibot";
import { useMobiusSlackIdentity, useMobiusSlackUrl } from "@/components/slack/mobius-slack-context";
import { useApiTransport } from "@/services/api/api-transport-context";
import { type GetToken, RequestError, request } from "./request";

type ResolveUrl = (path: string) => string;
interface ManagementContext {
    readonly fetchRequest: (request: Request) => Promise<Response>;
    readonly getToken: GetToken;
    readonly resolve: ResolveUrl;
}

const connectionSchema = v.pipe(
    v.variant("kind", [
        v.object({ kind: v.literal("not-configured") }),
        v.object({ kind: v.literal("not-installed"), appName: v.string(), slackAppId: v.string() }),
        v.object({
            kind: v.literal("connected"),
            appName: v.string(),
            slackAppId: v.string(),
            slackTeamId: v.string(),
            slackTeamName: v.nullable(v.string()),
        }),
        v.object({ kind: v.literal("disconnected"), appName: v.string(), slackAppId: v.string(), reason: v.string() }),
    ]),
    v.readonly(),
);
export type Connection = v.InferOutput<typeof connectionSchema>;
const botBindingSchema = v.variant("kind", [
    v.object({ kind: v.literal("unbound") }),
    v.object({ kind: v.literal("bound"), botId: v.string() }),
]);
export type BotBinding = v.InferOutput<typeof botBindingSchema>;
const botsSchema = v.pipe(
    v.object({
        bots: v.pipe(
            v.array(v.pipe(v.object({ id: v.string(), name: v.string(), binding: botBindingSchema }), v.readonly())),
            v.readonly(),
        ),
    }),
    v.readonly(),
);
const requiredText = v.pipe(v.string(), v.trim(), v.minLength(1));
export const registrationSchema = v.pipe(
    v.object({
        name: requiredText,
        clientId: requiredText,
        clientSecret: requiredText,
        signingSecret: requiredText,
        slackAppId: requiredText,
    }),
    v.readonly(),
);

export function managementError(error: unknown): string {
    return error instanceof RequestError
        ? error.message
        : "Unable to complete the request. Check the fields and try again.";
}

function slackAuthorizationUrl(value: unknown): string {
    const url = new URL(v.parse(v.string(), value));
    if (url.origin !== "https://slack.com" || url.pathname !== "/oauth/v2/authorize") {
        throw new RequestError("Invalid Slack authorization URL.");
    }
    return url.toString();
}

async function listBots(cx: ManagementContext, signal: AbortSignal) {
    return v.parse(
        botsSchema,
        await request(cx.resolve("/mobius-slack/api/slack/bots"), cx.getToken, cx.fetchRequest, signal),
    ).bots;
}

async function getConnection(cx: ManagementContext, botId: string, signal: AbortSignal): Promise<Connection> {
    return v.parse(
        connectionSchema,
        await request(
            cx.resolve(`/mobius-slack/api/slack/status?slackBotId=${encodeURIComponent(botId)}`),
            cx.getToken,
            cx.fetchRequest,
            signal,
        ),
    );
}

async function getManifest(cx: ManagementContext, name: string, signal: AbortSignal) {
    return v.parse(
        v.record(v.string(), v.unknown()),
        await request(
            cx.resolve(`/mobius-slack/api/slack/manifest?name=${encodeURIComponent(name)}`),
            cx.getToken,
            cx.fetchRequest,
            signal,
        ),
    );
}

async function registerApp(
    cx: ManagementContext,
    botId: string,
    input: v.InferOutput<typeof registrationSchema>,
    signal: AbortSignal,
): Promise<string> {
    const result = v.parse(
        v.object({ oauthAuthorizeUrl: v.string() }),
        await request(
            cx.resolve("/mobius-slack/api/slack/apps/register"),
            cx.getToken,
            cx.fetchRequest,
            signal,
            "POST",
            {
                ...v.parse(registrationSchema, input),
                slackBotId: botId,
            },
        ),
    );
    return slackAuthorizationUrl(result.oauthAuthorizeUrl);
}

async function saveConfigToken(cx: ManagementContext, refreshToken: string, signal: AbortSignal): Promise<void> {
    await request(cx.resolve("/mobius-slack/api/slack/config-token"), cx.getToken, cx.fetchRequest, signal, "PUT", {
        refreshToken,
    });
}

async function createApp(cx: ManagementContext, botId: string, name: string, signal: AbortSignal): Promise<string> {
    const result = v.parse(
        v.object({ oauthAuthorizeUrl: v.string() }),
        await request(cx.resolve("/mobius-slack/api/slack/apps"), cx.getToken, cx.fetchRequest, signal, "POST", {
            slackBotId: botId,
            name,
        }),
    );
    return slackAuthorizationUrl(result.oauthAuthorizeUrl);
}

async function getAuthorizationUrl(cx: ManagementContext, botId: string, signal: AbortSignal): Promise<string> {
    const result = v.parse(
        v.object({ url: v.string() }),
        await request(
            cx.resolve(`/mobius-slack/api/slack/oauth/url?slackBotId=${encodeURIComponent(botId)}`),
            cx.getToken,
            cx.fetchRequest,
            signal,
        ),
    );
    return slackAuthorizationUrl(result.url);
}

async function disconnectApp(cx: ManagementContext, botId: string, signal: AbortSignal): Promise<void> {
    await request(
        cx.resolve(`/mobius-slack/api/slack/apps/${encodeURIComponent(botId)}`),
        cx.getToken,
        cx.fetchRequest,
        signal,
        "DELETE",
    );
}

export function useManagementRequests() {
    const transport = useApiTransport();
    const { getToken } = useMobiusSlackIdentity();
    const resolve = useMobiusSlackUrl();
    const cx = useMemo<ManagementContext>(
        () => Object.freeze({ fetchRequest: transport.fetch, getToken, resolve }),
        [getToken, resolve, transport.fetch],
    );
    return useMemo(
        () =>
            Object.freeze({
                listBindableBots: async (signal: AbortSignal) => {
                    const result = v.parse(
                        v.object({ bots: v.array(v.object({ botId: v.string(), displayName: v.string() })) }),
                        await request(
                            cx.resolve("/mobius-slack/api/slack/chat-bots"),
                            cx.getToken,
                            cx.fetchRequest,
                            signal,
                        ),
                    );
                    return result.bots.map((bot) => ({ ...bot, projectId: "chat" }));
                },
                bindBot: async (
                    slackBotId: string,
                    input: { readonly botId: string; readonly projectId: string },
                    signal: AbortSignal,
                ): Promise<BotBinding> =>
                    v.parse(
                        botBindingSchema,
                        await request(
                            cx.resolve(`/mobius-slack/api/slack/bots/${encodeURIComponent(slackBotId)}/binding`),
                            cx.getToken,
                            cx.fetchRequest,
                            signal,
                            "PUT",
                            { botId: input.botId },
                        ),
                    ),
                listBots: (signal: AbortSignal) => listBots(cx, signal),
                getConnection: (botId: string, signal: AbortSignal) => getConnection(cx, botId, signal),
                getManifest: (name: string, signal: AbortSignal) => getManifest(cx, name, signal),
                registerApp: (botId: string, input: v.InferOutput<typeof registrationSchema>, signal: AbortSignal) =>
                    registerApp(cx, botId, input, signal),
                saveConfigToken: (refreshToken: string, signal: AbortSignal) =>
                    saveConfigToken(cx, refreshToken, signal),
                createApp: (botId: string, name: string, signal: AbortSignal) => createApp(cx, botId, name, signal),
                getAuthorizationUrl: (botId: string, signal: AbortSignal) => getAuthorizationUrl(cx, botId, signal),
                disconnectApp: (botId: string, signal: AbortSignal) => disconnectApp(cx, botId, signal),
            }),
        [cx],
    );
}
export type ManagementRequests = ReturnType<typeof useManagementRequests>;
