import {
    decodeAgentSettingsDiscoveredEvent,
    type SessionConfigOption,
    type SessionElicitationRequestedEvent,
    type SessionElicitationResolvedEvent,
    type SessionPermissionRequestedEvent,
    type SessionPermissionResolvedEvent,
} from "@moxt-ai/mobius-protocol";
import { connectMobiusChannelClient, type MobiusChannelClient } from "@moxt-ai/mobius-sdk/channel";
import * as v from "valibot";
import { CloudApiError, ManagementApi } from "../management/management-api.ts";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
const managedSessionSchema = v.pipe(
    v.object({
        id: identifier,
        title: v.string(),
        directoryLabel: v.string(),
        directoryId: v.string(),
        additionalDirectoryIds: v.array(v.string()),
        projectId: identifier,
        userId: identifier,
    }),
    v.readonly(),
);
export type ManagedChatSession = v.InferOutput<typeof managedSessionSchema>;
const workspaceSchema = v.object({
    status: v.string(),
    runtimeId: v.nullable(identifier),
    agents: v.array(
        v.object({
            runtimeId: identifier,
            agentRef: identifier,
            label: v.string(),
            machineName: v.string(),
            online: v.boolean(),
        }),
    ),
});
export type ChatWorkspace = v.InferOutput<typeof workspaceSchema>;
interface AgentSettingsResult {
    readonly options: readonly SessionConfigOption[];
}

export class BotChatApi {
    readonly #agentSettingsCache = new Map<string, AgentSettingsResult>();
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #origin: string;
    readonly #projectId: string;
    readonly #getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly #waitForChange: (request: Request) => Promise<void>;
    readonly listBots: ManagementApi["listBots"];
    readonly createBot: ManagementApi["createBot"];
    readonly deleteBot: ManagementApi["deleteBot"];
    readonly localRuntime = async (botId: string, signal: AbortSignal) =>
        v.parse(
            v.object({ runtimeId: identifier, agentRef: identifier }),
            await this.#request(botId, "local-runtime", {}, signal),
        );
    readonly localSessions = async (botId: string, signal: AbortSignal) =>
        v.parse(
            v.object({ sessions: v.array(managedSessionSchema) }),
            await this.#request(botId, "local-sessions", {}, signal),
        ).sessions;
    readonly createLocalSession = async (
        botId: string,
        input: { readonly action: "create" } | { readonly action: "import"; readonly sessionId: string },
        signal: AbortSignal,
    ) =>
        v.parse(
            v.object({ sessionId: identifier, runtimeId: identifier, agentRef: identifier }),
            await this.#request(botId, "local-sessions/create", input, signal),
        );
    readonly connectLocalRuntime = async (
        botId: string,
        signal: AbortSignal,
        callbacks: {
            readonly onActivity: () => void;
            readonly onStatus: (online: boolean) => void;
            readonly onPermission?: (event: SessionPermissionRequestedEvent) => void;
            readonly onPermissionResolved?: (event: SessionPermissionResolvedEvent) => void;
            readonly onElicitation?: (event: SessionElicitationRequestedEvent) => void;
            readonly onElicitationResolved?: (event: SessionElicitationResolvedEvent) => void;
        },
    ): Promise<MobiusChannelClient> => {
        signal.throwIfAborted();
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        const endpoint = new URL(
            `/morty/api/chat/projects/${encodeURIComponent(this.#projectId)}/bots/${encodeURIComponent(v.parse(identifier, botId))}/runtime-channel`,
            this.#origin,
        );
        endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        const client = await connectMobiusChannelClient({
            relayUrl: endpoint.toString(),
            protocols: ["morty-runtime", `auth.${token}`],
            onActivity: callbacks.onActivity,
            onStatus: callbacks.onStatus,
            ...(callbacks.onPermission === undefined ? {} : { onPermission: callbacks.onPermission }),
            ...(callbacks.onPermissionResolved === undefined
                ? {}
                : { onPermissionResolved: callbacks.onPermissionResolved }),
            ...(callbacks.onElicitation === undefined ? {} : { onElicitation: callbacks.onElicitation }),
            ...(callbacks.onElicitationResolved === undefined
                ? {}
                : { onElicitationResolved: callbacks.onElicitationResolved }),
        });
        if (signal.aborted) {
            client.close();
            signal.throwIfAborted();
        }
        signal.addEventListener("abort", () => client.close(), { once: true });
        return client;
    };
    constructor(options: {
        readonly fetchRequest: (request: Request) => Promise<Response>;
        readonly origin: string;
        readonly projectId: string;
        readonly getToken: (signal: AbortSignal) => Promise<string | null>;
        readonly waitForChange: (request: Request) => Promise<void>;
    }) {
        this.#origin = v.parse(v.pipe(v.string(), v.url()), options.origin);
        this.#projectId = v.parse(identifier, options.projectId);
        this.#fetchRequest = options.fetchRequest;
        this.#getToken = options.getToken;
        this.#waitForChange = options.waitForChange;
        const management = new ManagementApi(options);
        this.listBots = management.listBots;
        this.createBot = management.createBot;
        this.deleteBot = management.deleteBot;
    }
    readonly agentSettings = async (
        botId: string,
        agentRef: string,
        refresh: boolean,
        signal: AbortSignal,
    ): Promise<AgentSettingsResult> => {
        signal.throwIfAborted();
        const requestedBotId = v.parse(identifier, botId);
        const requestedAgentRef = v.parse(identifier, agentRef);
        const cacheKey = JSON.stringify([requestedBotId, requestedAgentRef]);
        if (refresh) {
            this.#agentSettingsCache.delete(cacheKey);
        } else {
            const cached = this.#agentSettingsCache.get(cacheKey);
            if (cached !== undefined) {
                return cached;
            }
        }
        const result = v.parse(
            v.object({ settings: v.unknown() }),
            await this.#request(requestedBotId, "agent-settings", { agentRef: requestedAgentRef }, signal),
        );
        const discovered = decodeAgentSettingsDiscoveredEvent(JSON.stringify(result.settings));
        const settings = {
            options: discovered.settings.map(({ defaultValue, ...setting }) => ({
                ...setting,
                currentValue:
                    setting.type === "select" && !setting.values.some((value) => value.value === defaultValue)
                        ? (setting.values[0]?.value ?? "")
                        : defaultValue,
            })),
        };
        this.#agentSettingsCache.set(cacheKey, settings);
        return settings;
    };
    readonly createPairingInstruction = async (botId: string, signal: AbortSignal) => {
        const ticket = v.parse(
            v.object({ url: v.pipe(v.string(), v.url()), expiresAt: v.pipe(v.string(), v.isoTimestamp()) }),
            await this.#request(botId, "pairing-instruction", { botId }, signal),
        );
        const url = new URL(ticket.url);
        if (
            url.origin !== new URL(this.#origin).origin ||
            url.pathname !== "/pair.md" ||
            !/^mobius_pair_v2\.[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get("token") ?? "")
        ) {
            throw new CloudApiError("INVALID_PAIRING_INSTRUCTION", "Pairing instruction is invalid.");
        }
        return ticket;
    };
    readonly workspace = async (botId: string, parent: AbortSignal): Promise<ChatWorkspace> =>
        v.parse(workspaceSchema, await this.#request(botId, "workspace", undefined, parent));
    readonly waitForWorkspaceChange = async (botId: string, parent: AbortSignal): Promise<void> => {
        const signal = AbortSignal.any([parent, AbortSignal.timeout(10 * 60 * 1000)]);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        await this.#waitForChange(
            new Request(
                new URL(
                    `/morty/api/chat/projects/${encodeURIComponent(this.#projectId)}/bots/${encodeURIComponent(v.parse(identifier, botId))}/workspace`,
                    this.#origin,
                ),
                { method: "POST", headers: { authorization: `Bearer ${token}` }, signal },
            ),
        );
    };
    readonly #request = async (
        botId: string,
        operation: string,
        body: unknown,
        parent: AbortSignal,
    ): Promise<unknown> => {
        const signal = AbortSignal.any([parent, AbortSignal.timeout(operation === "agent-settings" ? 120000 : 45000)]);
        const requestedBotId = v.parse(identifier, botId);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        const response = await this.#fetchRequest(
            new Request(
                new URL(
                    operation === "pairing-instruction"
                        ? `/morty/api/projects/${encodeURIComponent(this.#projectId)}/identity/pairings`
                        : `/morty/api/chat/projects/${encodeURIComponent(this.#projectId)}/bots/${encodeURIComponent(requestedBotId)}/${operation}`,
                    this.#origin,
                ),
                {
                    method: "POST",
                    signal,
                    redirect: "error",
                    headers: {
                        authorization: `Bearer ${token}`,
                        "content-type": "application/json",
                    },
                    body: body === undefined ? null : JSON.stringify(body),
                },
            ),
        );
        let value: unknown;
        try {
            value = await response.json();
        } catch {
            signal.throwIfAborted();
            throw new CloudApiError("CHAT_UNAVAILABLE", "Chat returned an invalid response.");
        }
        signal.throwIfAborted();
        if (!response.ok) {
            const parsed = v.safeParse(v.object({ error: v.object({ code: v.string(), message: v.string() }) }), value);
            throw new CloudApiError(
                parsed.success ? parsed.output.error.code : "CHAT_UNAVAILABLE",
                parsed.success ? parsed.output.error.message : "Chat is unavailable.",
                response.status,
            );
        }
        return value;
    };
}
