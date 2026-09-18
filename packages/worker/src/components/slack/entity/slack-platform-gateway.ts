import type { BotConfiguration } from "../../management/entity/bot-configuration.ts";

export interface SlackPlatformGateway {
    readonly createPairing: (
        projectId: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => Promise<Readonly<Record<string, unknown>>>;
    readonly readPairing: (
        projectId: string,
        pairingId: string,
        signal: AbortSignal,
    ) => Promise<{ readonly status: string }>;
    readonly migrateLegacyBot: (
        projectId: string,
        botId: string,
        userId: string,
        signal: AbortSignal,
    ) => Promise<{ readonly configuration: BotConfiguration | null; readonly instructions: string }>;
    readonly openAutomatedChatSession: (
        projectId: string,
        selection: BotConfiguration,
        sessionId: string,
        title: string,
        signal: AbortSignal,
    ) => Promise<string>;
    readonly submitAutomatedChatTurn: (
        projectId: string,
        sessionId: string,
        input: { readonly commandId: string; readonly prompt: string; readonly instructions: string },
        signal: AbortSignal,
    ) => Promise<{ readonly text: string; readonly stopReason: string }>;
}
