import * as v from "valibot";
import { CloudApiError } from "../management/management-api.ts";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
const chatAccessSchema = v.pipe(
    v.object({
        accessToken: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
        accessTokenId: identifier,
    }),
    v.readonly(),
);
const chatSessionSchema = v.pipe(
    v.object({
        botId: identifier,
        sessionId: identifier,
        title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    }),
    v.readonly(),
);

export type ChatSession = v.InferOutput<typeof chatSessionSchema>;
export type MobiusChatAccess = v.InferOutput<typeof chatAccessSchema> & {
    readonly appId: string;
    readonly botId: string;
    readonly mobiusBaseUrl: string;
};

export class ChatCloudApi {
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly #origin: string;
    readonly #projectId: string;
    readonly #appId: string;
    readonly #mobiusBaseUrl: string;
    constructor(options: {
        readonly appId: string;
        readonly fetchRequest?: (request: Request) => Promise<Response>;
        readonly getToken: (signal: AbortSignal) => Promise<string | null>;
        readonly mobiusBaseUrl: string;
        readonly origin: string;
        readonly projectId: string;
    }) {
        this.#appId = v.parse(v.pipe(v.string(), v.minLength(1)), options.appId);
        this.#fetchRequest = options.fetchRequest ?? ((request) => fetch(request));
        this.#getToken = options.getToken;
        this.#mobiusBaseUrl = v.parse(v.pipe(v.string(), v.url()), options.mobiusBaseUrl);
        this.#origin = options.origin;
        this.#projectId = v.parse(identifier, options.projectId);
    }

    readonly open = async (botId: string, signal: AbortSignal): Promise<MobiusChatAccess> => ({
        ...v.parse(
            chatAccessSchema,
            await this.#request(`/bots/${v.parse(identifier, botId)}/access-tokens`, "POST", undefined, signal),
        ),
        appId: this.#appId,
        botId,
        mobiusBaseUrl: this.#mobiusBaseUrl,
    });

    readonly revoke = async (access: MobiusChatAccess, signal: AbortSignal): Promise<void> => {
        await this.#request(`/access-tokens/${v.parse(identifier, access.accessTokenId)}`, "DELETE", undefined, signal);
    };

    readonly regenerate = async (access: MobiusChatAccess, signal: AbortSignal): Promise<MobiusChatAccess> => ({
        ...v.parse(
            chatAccessSchema,
            await this.#request(
                `/access-tokens/${v.parse(identifier, access.accessTokenId)}/regenerate`,
                "POST",
                undefined,
                signal,
                "management",
            ),
        ),
        appId: this.#appId,
        botId: access.botId,
        mobiusBaseUrl: this.#mobiusBaseUrl,
    });

    readonly listSessions = async (signal: AbortSignal): Promise<readonly ChatSession[]> =>
        v.parse(
            v.object({ sessions: v.array(chatSessionSchema) }),
            await this.#request("/sessions", "GET", undefined, signal),
        ).sessions;

    readonly recordSession = async (session: ChatSession, signal: AbortSignal): Promise<ChatSession> =>
        v.parse(chatSessionSchema, await this.#request("/sessions", "POST", session, signal));

    readonly renameSession = async (sessionId: string, title: string, signal: AbortSignal): Promise<void> => {
        await this.#request(`/sessions/${v.parse(identifier, sessionId)}`, "PATCH", { title }, signal);
    };

    readonly deleteSession = async (sessionId: string, signal: AbortSignal): Promise<void> => {
        await this.#request(`/sessions/${v.parse(identifier, sessionId)}`, "DELETE", undefined, signal);
    };

    readonly #request = async (
        path: string,
        method: "DELETE" | "GET" | "PATCH" | "POST",
        body: object | undefined,
        requestSignal: AbortSignal,
        component: "chat" | "management" = "chat",
    ): Promise<unknown> => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Sign in to continue.");
        }
        const response = await this.#fetchRequest(
            new Request(
                new URL(
                    `/mobius-cloud/api/${component === "chat" ? `chat/projects/${encodeURIComponent(this.#projectId)}` : `projects/${encodeURIComponent(this.#projectId)}/management`}${path}`,
                    this.#origin,
                ),
                {
                    method,
                    signal,
                    headers: {
                        authorization: `Bearer ${token}`,
                        ...(body === undefined ? {} : { "content-type": "application/json" }),
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                },
            ),
        );
        if (response.status === 204) {
            return null;
        }
        const value: unknown = await response.json();
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
