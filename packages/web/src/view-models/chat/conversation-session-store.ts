import type { PromptImage, PromptResource } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import type { BotChatApi, ChatDraftConfiguration } from "../../services/chat/bot-chat-api.ts";
import type { OpenMobiusSession } from "./open-session.ts";

type InitialSessionAttachment =
    | { readonly kind: "image"; readonly image: PromptImage }
    | { readonly kind: "resource"; readonly resource: PromptResource };

type ConversationSessionState =
    | { readonly kind: "idle" }
    | { readonly kind: "opening" }
    | {
          readonly kind: "ready";
          readonly conversationId: string;
          readonly session: OpenMobiusSession;
      }
    | { readonly kind: "failed"; readonly message: string };

export interface ConversationSessionStore {
    readonly state: ConversationSessionState;
    readonly clear: () => void;
    readonly open: (botId: string, conversationId: string, signal: AbortSignal) => Promise<void>;
    readonly create: (
        botId: string,
        conversationKey: string,
        settings: ChatDraftConfiguration,
        title: string,
        initialPrompt: string,
        initialAttachments: readonly InitialSessionAttachment[],
        signal: AbortSignal,
    ) => Promise<void>;
}

export function createConversationSessionStore(
    requests: Pick<
        BotChatApi,
        "access" | "conversationSession" | "createConversation" | "submitTurn" | "workspaceDirectory"
    >,
) {
    return createStore<ConversationSessionStore>()((set) => ({
        state: { kind: "idle" },
        clear: () => set({ state: { kind: "idle" } }),
        open: async (botId, conversationId, signal) => {
            set({ state: { kind: "opening" } });
            try {
                const access = await requests.access(botId, signal, conversationId);
                const directory = await requests.workspaceDirectory(botId, access.workspaceRef, signal);
                signal.throwIfAborted();
                set({
                    state: {
                        kind: "ready",
                        conversationId: access.conversationId,
                        session: requests.conversationSession(access, { kind: "idle" }, directory.directoryLabel),
                    },
                });
            } catch (cause) {
                signal.throwIfAborted();
                set({
                    state: { kind: "failed", message: cause instanceof Error ? cause.message : "Session unavailable." },
                });
            }
        },
        create: async (botId, conversationKey, settings, title, initialPrompt, initialAttachments, signal) => {
            set({ state: { kind: "opening" } });
            try {
                const access = await requests.createConversation(botId, conversationKey, settings, signal, title);
                const accepted = await requests.submitTurn(
                    botId,
                    access.sessionId,
                    {
                        additionalDirectoryIds: [],
                        artifactIds: [],
                        content: initialPrompt,
                        idempotencyKey: conversationKey,
                        images: initialAttachments.flatMap((attachment) =>
                            attachment.kind === "image" ? [attachment.image] : [],
                        ),
                        resources: initialAttachments.flatMap((attachment) =>
                            attachment.kind === "resource" ? [attachment.resource] : [],
                        ),
                    },
                    signal,
                );
                signal.throwIfAborted();
                set({
                    state: {
                        kind: "ready",
                        conversationId: access.conversationId,
                        session: requests.conversationSession(
                            access,
                            {
                                kind: "running",
                                commandId: conversationKey,
                                turnId: accepted.turnId,
                            },
                            settings.workspaceLabel,
                        ),
                    },
                });
            } catch (cause) {
                signal.throwIfAborted();
                set({
                    state: { kind: "failed", message: cause instanceof Error ? cause.message : "Session unavailable." },
                });
            }
        },
    }));
}
