import { BotChatApi, type ChatWorkspace, type ManagedChatSession } from "@/services/chat/bot-chat-api";
import type { ManagedBot, ManagedBotDetail } from "@/services/management/management-api";
import { ManagementApi } from "@/services/management/management-api";

export type ChatBot = ManagedBot;
export type ChatBotDetail = ManagedBotDetail;

export class ChatBotApi {
    readonly #chat: BotChatApi;
    readonly #management: ManagementApi;

    constructor(options: {
        readonly origin: string;
        readonly projectId: string;
        readonly getToken: (signal: AbortSignal) => Promise<string | null>;
    }) {
        this.#chat = new BotChatApi(options);
        this.#management = new ManagementApi(options);
    }

    readonly listBots = async (signal: AbortSignal): Promise<readonly ChatBot[]> =>
        await this.#management.listBots(signal);

    readonly readBot = async (botId: string, signal: AbortSignal): Promise<ChatBotDetail> =>
        await this.#management.readBot(botId, signal);

    readonly createBot = async (displayName: string, signal: AbortSignal): Promise<ChatBot> =>
        await this.#management.createBot(displayName, signal);

    readonly updateBot = async (
        botId: string,
        input: { readonly displayName: string; readonly instructions: string },
        signal: AbortSignal,
    ): Promise<ChatBotDetail> => await this.#management.updateBot(botId, input, signal);

    readonly workspace = async (botId: string, signal: AbortSignal): Promise<ChatWorkspace> =>
        await this.#chat.workspace(botId, signal);

    readonly conversations = async (botId: string, signal: AbortSignal): Promise<readonly ManagedChatSession[]> =>
        await this.#chat.managedSessions(botId, signal);
}
