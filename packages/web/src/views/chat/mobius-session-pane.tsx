import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { dataTestId } from "@/data-testid";
import type { MarkdownImageReader } from "../../components/agents/agent-markdown.tsx";
import { AgentThinking, type AgentThinkingEntry } from "../../components/chat/agent-thinking.tsx";
import { BotChatComposer } from "../../components/chat/bot-chat-composer.tsx";
import { ChatComposerMoreMenu } from "../../components/chat/chat-composer-more-menu.tsx";
import { ChatConfigurationMenu } from "../../components/chat/chat-configuration-menu.tsx";
import { ChatMessageQueue } from "../../components/chat/chat-message-queue.tsx";
import { FilePreview } from "../../components/chat/file-preview.tsx";
import {
    type ElicitationInteractionResponse,
    type PermissionInteractionResponse,
    SessionInteractionCards,
} from "../../components/chat/session-interactions.tsx";
import { WorkingIndicator } from "../../components/chat/working-indicator.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { FollowLatestScrollArea } from "../../components/utils/follow-latest-scroll-area.tsx";
import { LoadMoreTrigger } from "../../components/utils/load-more-trigger.tsx";
import { registerMortyDebugSession } from "../../debug-bridge.ts";
import { type BotChatApi, connectedChatRuntimeAgents } from "../../services/chat/bot-chat-api.ts";
import type { QueuedDraftMessage } from "../../view-models/chat/conversation-creation-machine.ts";
import { createBrowserFilePreviewStore } from "../../view-models/chat/file-preview-store.ts";
import type { OpenMobiusSession } from "../../view-models/chat/open-session.ts";
import type { SessionActivityState } from "../../view-models/chat/session-activity-machine.ts";
import { sessionDebugBlocks } from "../../view-models/chat/session-debug-blocks.ts";
import { createSessionPaneModel, sessionPanePresentation } from "../../view-models/chat/session-pane-store.ts";
import { type SessionMessage, sessionTextValue } from "../../view-models/chat/session-presentation.ts";
import { reportApplicationError } from "../../view-models/report-error.ts";
import { MobiusAssistantText, MobiusSessionMessage } from "./mobius-session-message.tsx";

type SessionRenderItem =
    | {
          readonly kind: "assistant-text";
          readonly id: string;
          readonly messageId: string | null;
          readonly text: string;
      }
    | {
          readonly kind: "event";
          readonly message: SessionMessage;
      }
    | {
          readonly entries: readonly AgentThinkingEntry[];
          readonly id: string;
          readonly kind: "thinking";
      };

function assistantText(message: SessionMessage): { readonly messageId: string | null; readonly text: string } | null {
    if (
        message.role === "assistant" &&
        message.presentation.kind === "message" &&
        message.presentation.content.type === "text"
    ) {
        return { messageId: message.presentation.messageId, text: sessionTextValue(message.presentation.content.text) };
    }
    return null;
}

function thinkingEntry(message: SessionMessage): AgentThinkingEntry | null {
    if (message.role !== "assistant") {
        return null;
    }
    if (message.presentation.kind === "tool") {
        return message.presentation.entry;
    }
    if (message.presentation.kind === "thought" && message.presentation.content.type === "text") {
        return {
            id: message.firstEvent.eventId,
            kind: "reasoning",
            messageId: message.presentation.messageId,
            omitted: message.presentation.omitted,
            text: sessionTextValue(message.presentation.content.text),
            truncated: message.presentation.content.text.truncated,
        };
    }
    return null;
}

function sessionRenderItems(messages: readonly SessionMessage[]): readonly SessionRenderItem[] {
    type RenderItemBuilder =
        | { kind: "assistant-text"; id: string; messageId: string | null; text: string[] }
        | { readonly kind: "event"; readonly message: SessionMessage }
        | { entries: AgentThinkingEntry[]; readonly id: string; readonly kind: "thinking" };
    const items: RenderItemBuilder[] = [];
    for (const message of messages) {
        const text = assistantText(message);
        const thinking = thinkingEntry(message);
        const previous = items.at(-1);
        if (text !== null && previous?.kind === "assistant-text" && previous.messageId === text.messageId) {
            previous.text.push(text.text);
        } else if (text !== null) {
            items.push({
                kind: "assistant-text",
                id: message.firstEvent.eventId,
                messageId: text.messageId,
                text: [text.text],
            });
        } else if (thinking !== null && previous?.kind === "thinking") {
            previous.entries.push(thinking);
        } else if (thinking !== null) {
            items.push({ entries: [thinking], id: message.firstEvent.eventId, kind: "thinking" });
        } else {
            items.push({ kind: "event", message });
        }
    }
    return items.map(
        (item): SessionRenderItem => (item.kind === "assistant-text" ? { ...item, text: item.text.join("") } : item),
    );
}

function MessageListSkeleton() {
    return (
        <div role="status" aria-label="Loading messages" className="mx-auto w-full min-w-0 max-w-[920px]">
            <span className="sr-only">Loading messages</span>
            <div aria-hidden="true" className="grid animate-pulse gap-8 motion-reduce:animate-none">
                <div className="ml-auto grid w-full max-w-[68%] justify-items-end gap-2">
                    <div className="h-4 w-2/3 rounded-full bg-muted" />
                    <div className="h-4 w-full rounded-full bg-muted" />
                    <div className="h-4 w-4/5 rounded-full bg-muted" />
                </div>
                <div className="grid w-full max-w-[78%] gap-2">
                    <div className="h-4 w-1/3 rounded-full bg-muted" />
                    <div className="h-4 w-full rounded-full bg-muted" />
                    <div className="h-4 w-5/6 rounded-full bg-muted" />
                    <div className="h-4 w-3/5 rounded-full bg-muted" />
                </div>
            </div>
        </div>
    );
}

/**
 * Stands in for older messages while an earlier history page is fetched above
 * the visible list. It carries no text of its own so the placeholder reads as
 * content rather than as a status label.
 */
function OlderHistorySkeleton() {
    return (
        <div aria-label="Loading older messages" className="mx-auto mb-8 w-full min-w-0 max-w-[920px]" role="status">
            <div aria-hidden="true" className="grid animate-pulse gap-8 motion-reduce:animate-none">
                <div className="ml-auto grid w-full max-w-[68%] justify-items-end gap-2">
                    <div className="h-4 w-2/3 rounded-full bg-muted" />
                    <div className="h-4 w-4/5 rounded-full bg-muted" />
                </div>
                <div className="grid w-full max-w-[78%] gap-2">
                    <div className="h-4 w-2/5 rounded-full bg-muted" />
                    <div className="h-4 w-full rounded-full bg-muted" />
                </div>
            </div>
        </div>
    );
}

export function MobiusSessionPane({
    session,
    initialMessage,
    botId,
    requests,
    onStatusChange,
    onTitleChange,
}: {
    readonly session: OpenMobiusSession;
    readonly initialMessage?: QueuedDraftMessage | undefined;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "connectSession" | "workspace">;
    readonly onStatusChange: (sessionId: string, status: SessionActivityState) => void;
    readonly onTitleChange: (sessionId: string, title: string) => void;
}) {
    const sessionId = session.result.ready.sessionId;
    const [pane] = useState(() =>
        createSessionPaneModel({
            session,
            botId,
            requests,
            initialMessage,
            onTitleChange,
        }),
    );
    const model = useStore(pane.store);
    const [filePreview] = useState(() => createBrowserFilePreviewStore(pane.readFile));
    const preview = useStore(filePreview);
    const delivery = useStore(pane.delivery);
    const messageQueue = useStore(pane.messageQueue);
    const taskControls = useStore(pane.tasks);
    const lifetime = useRef<AbortController | null>(null);
    const messageList = useRef<HTMLDivElement | null>(null);
    const [harnesses, setHarnesses] = useState<
        readonly { readonly agentRef?: string; readonly label: string; readonly value: string }[]
    >([{ agentRef: session.agentRef, label: session.agentRef, value: session.agentRef }]);
    const readImage = useCallback<MarkdownImageReader>(
        async (path, signal) => {
            for (let attempt = 0; attempt < 10; attempt += 1) {
                signal.throwIfAborted();
                const connection = pane.store.getState().connection;
                if (connection.kind === "ready") {
                    const file = await pane.readFile(path, signal);
                    return { bytes: file.bytes, mediaType: file.mediaType };
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            throw new Error("The Session is not connected.");
        },
        [pane],
    );

    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void pane.store.getState().connect(controller.signal);
        return () => {
            filePreview.getState().close();
            controller.abort();
            if (lifetime.current === controller) {
                lifetime.current = null;
            }
        };
    }, [filePreview, pane]);
    useEffect(
        () =>
            registerMortyDebugSession({
                sessionId,
                blocks: () => sessionDebugBlocks(pane.store.getState()),
            }),
        [pane, sessionId],
    );
    const loadOlderMessages = useCallback(
        async (signal: AbortSignal) => await pane.store.getState().loadOlderMessages(signal),
        [pane],
    );

    const run = (action: (signal: AbortSignal) => Promise<void>) => {
        const controller = lifetime.current;
        if (controller !== null) {
            void action(controller.signal).catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    reportApplicationError(cause, "session-pane-action");
                }
            });
        }
    };
    const runAndFollow = (action: (signal: AbortSignal) => Promise<void>) => {
        if (messageList.current !== null) {
            messageList.current.scrollTop = messageList.current.scrollHeight;
        }
        run(action);
    };
    const respondToPermission = async (response: PermissionInteractionResponse): Promise<void> => {
        const controller = lifetime.current;
        if (controller === null) {
            throw new Error("The Session is not connected.");
        }
        await pane.store.getState().respondToPermission(response, controller.signal);
    };
    const respondToElicitation = async (response: ElicitationInteractionResponse): Promise<void> => {
        const controller = lifetime.current;
        if (controller === null) {
            throw new Error("The Session is not connected.");
        }
        await pane.store.getState().respondToElicitation(response, controller.signal);
    };
    const presentation = sessionPanePresentation(model, delivery, taskControls, messageQueue);
    const renderItems = sessionRenderItems(model.messages);
    useEffect(() => {
        onStatusChange(sessionId, model.activity);
    }, [model.activity, onStatusChange, sessionId]);
    useEffect(() => {
        const controller = new AbortController();
        // The harness list is display-only in an existing conversation: every
        // entry is disabled, so a failed load just leaves the current harness.
        requests
            .workspace(botId, controller.signal)
            .then((workspace) => {
                setHarnesses(
                    connectedChatRuntimeAgents(workspace.runtime).map((agent) => ({
                        agentRef: agent.agentRef,
                        label: `${agent.label} · ${agent.machineName}`,
                        value: `${agent.runtimeId}:${agent.agentRef}`,
                    })),
                );
            })
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    reportApplicationError(cause, "session-pane-harnesses");
                }
            });
        return () => controller.abort();
    }, [botId, requests]);
    const configure = (option: SessionConfigOption, value: string, booleanValue: boolean) =>
        run(async (signal) => await pane.store.getState().configure(option, value, booleanValue, signal));
    const openLocalFile = useCallback(
        (path: string) => {
            const controller = lifetime.current;
            if (controller !== null) {
                void filePreview.getState().open(path, controller.signal);
            }
        },
        [filePreview],
    );

    return (
        <>
            <section className="flex min-h-0 min-w-0 flex-1 animate-cloud-enter flex-col motion-reduce:animate-none">
                <header className="flex h-12 shrink-0 items-center border-b border-border/80 px-4 sm:px-8 lg:px-12">
                    <h2 className="min-w-0 truncate text-sm font-semibold" title={model.title || "Untitled session"}>
                        {model.title || "Untitled session"}
                    </h2>
                </header>
                <FollowLatestScrollArea
                    role="log"
                    container={messageList}
                    followThreshold={80}
                    aria-label="Messages"
                    className="min-h-0 flex-1 overflow-y-auto px-4 py-6 [scrollbar-color:#c8d5ce_transparent] [scrollbar-width:thin] sm:px-8 sm:py-10 lg:px-12"
                >
                    {model.messages.length === 0 && model.connection.kind === "loading" && <MessageListSkeleton />}
                    {model.messages.length === 0 && model.connection.kind === "failed" && (
                        <div className="flex min-h-full items-center justify-center">
                            <div className="grid max-w-lg justify-items-center gap-4 px-6 text-center">
                                <p data-testid={dataTestId.sessionLoadFailure} role="alert">
                                    {model.connection.message}
                                </p>
                                <Button
                                    onClick={() => run(async (signal) => await pane.store.getState().connect(signal))}
                                    variant="outline"
                                >
                                    Reconnect
                                </Button>
                            </div>
                        </div>
                    )}
                    {model.messages.length === 0 &&
                        model.connection.kind === "ready" &&
                        model.activity.kind === "idle" &&
                        !model.historyLoading && (
                            <p className="text-center text-sm text-muted-foreground" role="status">
                                No message history is available for this conversation.
                            </p>
                        )}
                    {model.historyLoading && <OlderHistorySkeleton />}
                    <div className="mx-auto w-full min-w-0 max-w-[920px]">
                        {renderItems.map((item, index) => (
                            <div
                                key={item.kind === "event" ? item.message.firstEvent.eventId : item.id}
                                className="my-8 first:mt-0 last:mb-0"
                            >
                                {item.kind === "assistant-text" ? (
                                    <MobiusAssistantText
                                        openLocalFile={openLocalFile}
                                        readImage={readImage}
                                        text={item.text}
                                        streaming={
                                            model.activity.kind === "working" && index === renderItems.length - 1
                                        }
                                    />
                                ) : item.kind === "thinking" ? (
                                    <div data-testid={dataTestId.agentResponse}>
                                        <AgentThinking
                                            active={
                                                model.activity.kind === "working" && index === renderItems.length - 1
                                            }
                                            entries={item.entries}
                                            readImage={readImage}
                                        />
                                    </div>
                                ) : (
                                    <MobiusSessionMessage
                                        active={model.activity.kind === "working" && index === renderItems.length - 1}
                                        failureApproval={{ botId, kind: "bot-approval" }}
                                        message={item.message}
                                        deliveryUnknownUserMessageId={presentation.deliveryUnknownUserMessageId}
                                        onRemoveUnknownDelivery={pane.store.getState().removeUnknownDelivery}
                                        onRetryUnknownDelivery={() => run(pane.store.getState().retryUnknownDelivery)}
                                        readImage={readImage}
                                        openLocalFile={openLocalFile}
                                    />
                                )}
                            </div>
                        ))}
                        {presentation.outputState !== "idle" && (
                            <div className="mt-6 sm:px-2">
                                <WorkingIndicator />
                            </div>
                        )}
                    </div>
                </FollowLatestScrollArea>
                <LoadMoreTrigger
                    container={messageList}
                    hasMore={model.hasOlderHistory}
                    loading={model.historyLoading}
                    onLoadMore={loadOlderMessages}
                    revision={model.historyRevision}
                />
                <ChatMessageQueue
                    messages={messageQueue.messages}
                    steeringSupported={taskControls.steeringSupported}
                    onDelete={(commandId) =>
                        run(async (signal) => await pane.store.getState().deleteQueued(commandId, signal))
                    }
                    onSteer={(commandId) =>
                        runAndFollow(async (signal) => await pane.store.getState().steerQueued(commandId, signal))
                    }
                />
                {model.interactions.some((interaction) =>
                    interaction.kind === "elicitation"
                        ? interaction.elicitation.state.kind === "pending"
                        : interaction.permission.state.kind === "pending",
                ) && (
                    <div className="mx-auto mt-4 max-h-[50vh] w-full max-w-[920px] shrink-0 overflow-y-auto px-3 [scrollbar-color:#c8d5ce_transparent] [scrollbar-width:thin] sm:mt-5 sm:px-5">
                        <SessionInteractionCards
                            elicitations={model.interactions.flatMap((interaction) =>
                                interaction.kind === "elicitation" ? [interaction.elicitation] : [],
                            )}
                            permissions={model.interactions.flatMap((interaction) =>
                                interaction.kind === "permission" ? [interaction.permission] : [],
                            )}
                            onElicitationResponse={respondToElicitation}
                            onPermissionResponse={respondToPermission}
                        />
                    </div>
                )}
                <BotChatComposer
                    actions={
                        presentation.compactAvailable ? (
                            <ChatComposerMoreMenu
                                compactDisabled={presentation.compactDisabled}
                                onCompact={() => runAndFollow(pane.store.getState().compact)}
                            />
                        ) : undefined
                    }
                    attachments={model.attachments}
                    disabled={presentation.composerDisabled}
                    draft={model.draft}
                    error={presentation.composerError}
                    onAttachmentsChange={pane.store.getState().setAttachments}
                    onDraftChange={pane.store.getState().setDraft}
                    onStop={() => run(pane.store.getState().stop)}
                    onSubmit={() =>
                        runAndFollow(
                            presentation.shouldQueueOnSubmit
                                ? pane.store.getState().queueDraft
                                : pane.store.getState().send,
                        )
                    }
                    outputState={presentation.outputState}
                    submitDisabled={presentation.submitDisabled}
                >
                    <ChatConfigurationMenu
                        controls={[
                            {
                                disabled: true,
                                harnessLockedLabel: "The harness cannot be changed for an existing conversation.",
                                id: "harness",
                                kind: "select" as const,
                                label: "Harness",
                                locked: true,
                                onValueChange: () => {},
                                options: harnesses.some(
                                    (harness) => harness.value.split(":").at(-1) === session.agentRef,
                                )
                                    ? harnesses
                                    : [
                                          ...harnesses,
                                          {
                                              agentRef: session.agentRef,
                                              label: session.agentRef,
                                              value: session.agentRef,
                                          },
                                      ],
                                value:
                                    harnesses.find((harness) => harness.value.split(":").at(-1) === session.agentRef)
                                        ?.value ?? session.agentRef,
                            },
                            ...model.options.map((option) =>
                                option.type === "boolean"
                                    ? {
                                          checked: option.booleanValue,
                                          disabled: presentation.busy,
                                          id: option.id,
                                          kind: "boolean" as const,
                                          label: option.name,
                                          onCheckedChange: () => configure(option, "", !option.booleanValue),
                                          testId: dataTestId.agentSetting(option.id),
                                      }
                                    : {
                                          disabled: presentation.busy,
                                          id: option.id,
                                          kind: "select" as const,
                                          label: option.name,
                                          onValueChange: (value: string) => configure(option, value, false),
                                          options: option.values.map((value) => ({
                                              value: value.value,
                                              label: value.name,
                                          })),
                                          searchable: option.category === "model",
                                          testId: dataTestId.agentSetting(option.id),
                                          value: option.currentValue,
                                      },
                            ),
                        ]}
                        settingsLoading={model.operation.kind === "configuring"}
                    />
                    {model.operation.kind === "configuring" && (
                        <span role="status" className="sr-only">
                            Updating agent settings…
                        </span>
                    )}
                </BotChatComposer>
            </section>
            <FilePreview onClose={filePreview.getState().close} state={preview.state} />
        </>
    );
}
