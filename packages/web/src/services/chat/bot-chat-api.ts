import * as v from "valibot";
import { CloudApiError, ManagementApi } from "../management/management-api.ts";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
const accessSchema = v.pipe(
    v.strictObject({
        endpoint: v.pipe(v.string(), v.url()),
        conversationId: identifier,
        credential: v.pipe(v.string(), v.regex(/^mconv_[a-zA-Z0-9_-]{22}_[a-zA-Z0-9_-]{43}$/u)),
        expiresAt: v.pipe(v.string(), v.isoTimestamp()),
    }),
    v.readonly(),
);
export type ChatAccess = v.InferOutput<typeof accessSchema>;
const agentSelectionSchema = v.object({
    runtimeId: identifier,
    agentRef: identifier,
    workspaceRef: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
    agentConfigRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
const workspaceSchema = v.object({
    status: v.string(),
    selected: v.nullable(agentSelectionSchema),
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
export type ChatAgentSelection = v.InferOutput<typeof agentSelectionSchema>;
const runtimeAccessSchema = v.object({
    channelId: identifier,
    projectId: identifier,
    hostToken: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)),
    endpoint: v.pipe(v.string(), v.url()),
});

export class BotChatApi {
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #origin: string;
    readonly #getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly listBots: ManagementApi["listBots"];
    constructor(options: {
        readonly fetchRequest?: (request: Request) => Promise<Response>;
        readonly origin: string;
        readonly getToken: (signal: AbortSignal) => Promise<string | null>;
    }) {
        this.#origin = v.parse(v.pipe(v.string(), v.url()), options.origin);
        this.#fetchRequest = options.fetchRequest ?? ((request) => fetch(request));
        this.#getToken = options.getToken;
        this.listBots = new ManagementApi(options).listBots;
    }
    readonly access = async (botId: string, parent: AbortSignal): Promise<ChatAccess> =>
        v.parse(accessSchema, await this.#request(botId, "access", undefined, parent));
    readonly workspace = async (botId: string, parent: AbortSignal): Promise<ChatWorkspace> =>
        v.parse(workspaceSchema, await this.#request(botId, "workspace", undefined, parent));
    readonly selectAgent = async (botId: string, selection: ChatAgentSelection, parent: AbortSignal): Promise<void> => {
        await this.#request(botId, "setup", v.parse(agentSelectionSchema, selection), parent);
    };
    readonly runtimeAccess = async (botId: string, runtimeId: string, parent: AbortSignal) =>
        v.parse(
            runtimeAccessSchema,
            await this.#request(botId, "runtime-access", { runtimeId: v.parse(identifier, runtimeId) }, parent),
        );
    readonly #request = async (
        botId: string,
        operation: string,
        body: unknown,
        parent: AbortSignal,
    ): Promise<unknown> => {
        const signal = AbortSignal.any([parent, AbortSignal.timeout(45000)]);
        const requestedBotId = v.parse(identifier, botId);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        const response = await this.#fetchRequest(
            new Request(
                new URL(`/mobius-cloud/api/chat/bots/${encodeURIComponent(requestedBotId)}/${operation}`, this.#origin),
                {
                    method: "POST",
                    signal,
                    redirect: "error",
                    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
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
            );
        }
        return value;
    };
}
