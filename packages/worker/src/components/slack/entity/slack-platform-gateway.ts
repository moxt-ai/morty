import type { ChatBotBinding } from "./chat-bot-binding.ts";

export interface SlackPlatformGateway {
    readonly chatAgents: (
        projectId: string,
        signal: AbortSignal,
    ) => Promise<
        readonly {
            readonly runtimeId: string;
            readonly agentRef: string;
            readonly online: boolean;
        }[]
    >;
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
    readonly openAutomatedChatSession: (
        projectId: string,
        selection: Pick<ChatBotBinding, "runtimeId" | "agentRef">,
        sessionId: string,
        title: string,
        signal: AbortSignal,
    ) => Promise<string>;
    readonly submitAutomatedChatTurn: (
        projectId: string,
        selection: Pick<ChatBotBinding, "runtimeId" | "agentRef">,
        sessionId: string,
        input: { readonly commandId: string; readonly prompt: string; readonly instructions: string },
        signal: AbortSignal,
    ) => Promise<{ readonly text: string; readonly stopReason: string }>;
}
