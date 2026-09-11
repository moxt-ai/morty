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
    readonly access = async (botId: string, parent: AbortSignal): Promise<ChatAccess> => {
        const signal = AbortSignal.any([parent, AbortSignal.timeout(45000)]);
        const requestedBotId = v.parse(identifier, botId);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        const response = await this.#fetchRequest(
            new Request(
                new URL(`/mobius-cloud/api/chat/bots/${encodeURIComponent(requestedBotId)}/access`, this.#origin),
                {
                    method: "POST",
                    signal,
                    redirect: "error",
                    headers: { authorization: `Bearer ${token}` },
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
        return v.parse(accessSchema, value);
    };
}
