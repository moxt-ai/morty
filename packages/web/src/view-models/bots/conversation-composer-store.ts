import {
    conversationTitleFromText,
    type MobiusBotOwnerClient,
    type PromptImage,
    type PromptResource,
} from "@moxt-ai/mobius-sdk";
import type { StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";
import { uploadBotPromptAttachments } from "@/services/bots/bot-api";
import {
    AttachmentReadError,
    ReadPromptImage,
    ReadPromptResource,
    readPromptAttachment,
} from "@/services/chat/attachment-reader";
import type { ConversationSessionStore } from "@/view-models/bots/conversation-session-store";
import type { ConversationThreadStore } from "@/view-models/bots/conversation-thread-store";
import type { ChannelConnection } from "@/view-models/chat/channel";

export interface ConversationComposerStore {
    readonly attaching: boolean;
    readonly draft: string;
    readonly images: readonly PromptImage[];
    readonly resources: readonly PromptResource[];
    readonly submitting: boolean;
    readonly attachFiles: (files: FileList) => Promise<void>;
    readonly removeImage: (name: string) => void;
    readonly removeResource: (name: string) => void;
    readonly setDraft: (draft: string) => void;
    readonly submit: (signal: AbortSignal) => Promise<void>;
}

function failureMessage(error: unknown): string {
    return error instanceof Error ? error.message : "The conversation request failed.";
}

export const createConversationComposerStore = (
    botId: string,
    botDisplayName: string,
    client: MobiusBotOwnerClient,
    connection: ChannelConnection,
    threadStore: StoreApi<ConversationThreadStore>,
    sessionStore: StoreApi<ConversationSessionStore>,
) =>
    createStore<ConversationComposerStore>()((set, get) => ({
        attaching: false,
        draft: "",
        images: [],
        resources: [],
        submitting: false,
        attachFiles: async (files) => {
            const session = sessionStore.getState().state;
            if (session.kind !== "ready") {
                return;
            }
            set({ attaching: true });
            try {
                const attachments = await Promise.all(
                    Array.from(files)
                        .slice(0, 8)
                        .map(async (file) => await readPromptAttachment(file)),
                );
                let images = [...get().images];
                let resources = [...get().resources];
                for (const attachment of attachments) {
                    if (attachment instanceof ReadPromptImage) {
                        if (!session.ready.capabilities.imagePrompt) {
                            throw new AttachmentReadError(
                                "image_prompt_unsupported",
                                `${botDisplayName} does not accept image prompts.`,
                            );
                        }
                        images = [...images.filter((image) => image.name !== attachment.image.name), attachment.image];
                    } else if (attachment instanceof ReadPromptResource) {
                        if (!session.ready.capabilities.embeddedContextPrompt) {
                            throw new AttachmentReadError(
                                "resource_prompt_unsupported",
                                `${botDisplayName} does not accept embedded resources.`,
                            );
                        }
                        resources = [
                            ...resources.filter((resource) => resource.name !== attachment.resource.name),
                            attachment.resource,
                        ];
                    }
                }
                set({ images: Object.freeze(images), resources: Object.freeze(resources) });
                threadStore.getState().reportError("");
            } catch (error) {
                threadStore
                    .getState()
                    .reportError(
                        error instanceof AttachmentReadError
                            ? `${error.code}: ${error.message}`
                            : "attachment_read_failed: The selected file could not be read.",
                    );
            } finally {
                set({ attaching: false });
            }
        },
        removeImage: (name) => set({ images: get().images.filter((image) => image.name !== name) }),
        removeResource: (name) => set({ resources: get().resources.filter((resource) => resource.name !== name) }),
        setDraft: (draft) => set({ draft }),
        submit: async (lifetimeSignal) => {
            const thread = threadStore.getState();
            const session = sessionStore.getState();
            const composer = get();
            if (thread.state.kind !== "ready") {
                return;
            }
            const ownerConversation = thread.state.conversation.origin.kind === "owner";
            if (
                (ownerConversation && session.state.kind !== "ready") ||
                (!ownerConversation && (composer.images.length > 0 || composer.resources.length > 0)) ||
                (composer.draft.trim().length === 0 &&
                    composer.images.length === 0 &&
                    composer.resources.length === 0) ||
                thread.state.turn.kind !== "idle" ||
                session.configuring
            ) {
                return;
            }
            const text = composer.draft.trim();
            const images = composer.images;
            const resources = composer.resources;
            const clientMessageId = `web_${crypto.randomUUID()}`;
            const signal = AbortSignal.any([lifetimeSignal, AbortSignal.timeout(120_000)]);
            set({ draft: "", images: [], resources: [], submitting: true });
            threadStore.getState().reportError("");
            try {
                const artifactIds = ownerConversation
                    ? await uploadBotPromptAttachments(
                          connection,
                          thread.state.conversation.sessionId,
                          images,
                          resources,
                          signal,
                      )
                    : [];
                const accepted = await client.submitMessage(
                    botId,
                    thread.state.conversation.conversationId,
                    { actorRef: "project-owner", artifactIds, clientMessageId, text },
                    signal,
                );
                signal.throwIfAborted();
                const titleSource = text.length > 0 ? text : (images[0]?.name ?? resources[0]?.name ?? "Attachment");
                threadStore
                    .getState()
                    .markSubmitted(
                        clientMessageId,
                        text,
                        images,
                        resources,
                        accepted.turnId,
                        ownerConversation && thread.state.messages.length === 0
                            ? conversationTitleFromText(titleSource)
                            : null,
                        lifetimeSignal,
                    );
            } catch (error) {
                if (!lifetimeSignal.aborted) {
                    set({ draft: text, images, resources });
                    threadStore.getState().resetOptimistic();
                    threadStore.getState().reportError(failureMessage(error));
                }
            } finally {
                if (!lifetimeSignal.aborted) {
                    set({ submitting: false });
                }
            }
        },
    }));
