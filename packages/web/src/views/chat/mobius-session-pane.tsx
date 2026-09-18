import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { BotChatComposer } from "../../components/chat/bot-chat-composer.tsx";
import { ChatComposerMoreMenu } from "../../components/chat/chat-composer-more-menu.tsx";
import { ChatConfigurationMenu } from "../../components/chat/chat-configuration-menu.tsx";
import { ChatMessageQueue } from "../../components/chat/chat-message-queue.tsx";
import {
    type ElicitationInteractionResponse,
    type PermissionInteractionResponse,
    SessionInteractionCards,
} from "../../components/chat/session-interactions.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { OpenMobiusSession } from "../../view-models/chat/open-session.ts";
import { createSessionPaneModel, sessionPanePresentation } from "../../view-models/chat/session-pane-store.ts";
import { MobiusSessionMessage } from "./mobius-session-message.tsx";

export function MobiusSessionPane({
    session,
    botId,
    requests,
    endRemoteAccess,
}: {
    readonly session: OpenMobiusSession;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "connectSession" | "steerTurn" | "submitTurn">;
    readonly endRemoteAccess?: (signal: AbortSignal) => Promise<void>;
}) {
    const sessionId = session.result.ready.sessionId;
    const [pane] = useState(() =>
        createSessionPaneModel({
            session,
            botId,
            requests,
            storage: window.localStorage,
            endRemoteAccess: endRemoteAccess ?? (async () => Promise.resolve()),
        }),
    );
    const model = useStore(pane.store);
    const delivery = useStore(pane.delivery);
    const messageQueue = useStore(pane.messageQueue);
    const taskControls = useStore(pane.tasks);
    const remoteAccess = useStore(pane.remoteAccess);
    const lifetime = useRef<AbortController | null>(null);
    const messageList = useRef<HTMLDivElement | null>(null);
    const followLatest = useRef(true);

    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void pane.store.getState().connect(controller.signal);
        return () => {
            controller.abort();
            if (lifetime.current === controller) {
                lifetime.current = null;
            }
        };
    }, [pane]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll after rendered message content changes, unless the user is reading older history.
    useEffect(() => {
        if (followLatest.current && messageList.current !== null) {
            messageList.current.scrollTop = messageList.current.scrollHeight;
        }
    }, [model.messages]);

    const run = (action: (signal: AbortSignal) => Promise<void>) => {
        const controller = lifetime.current;
        if (controller !== null) {
            void action(controller.signal);
        }
    };
    const runAndFollow = (action: (signal: AbortSignal) => Promise<void>) => {
        followLatest.current = true;
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
    const configure = (option: SessionConfigOption, value: string) =>
        run(async (signal) => await pane.store.getState().configure(option, value, signal));

    if (endRemoteAccess !== undefined && remoteAccess.state.kind === "ended") {
        return (
            <section className="m-auto grid max-w-lg gap-3 p-8 text-center">
                <h1 className="text-2xl font-semibold">Remote access ended</h1>
                <p>Your local task is still running on your computer. This browser can no longer open it.</p>
            </section>
        );
    }
    return (
        <section className="flex min-h-0 min-w-0 flex-1 animate-cloud-enter flex-col motion-reduce:animate-none">
            {endRemoteAccess !== undefined && (
                <div className="flex items-center justify-end gap-2 border-b border-border px-4 py-2">
                    {remoteAccess.state.kind === "confirming" ? (
                        <>
                            <span className="text-sm">End access for every remote browser?</span>
                            <Button
                                variant="destructive"
                                disabled={false}
                                onClick={() => run(pane.store.getState().endRemoteAccess)}
                            >
                                Confirm end access
                            </Button>
                            <Button variant="ghost" onClick={pane.remoteAccess.getState().cancelEnd}>
                                Cancel
                            </Button>
                        </>
                    ) : (
                        <Button
                            variant="outline"
                            disabled={remoteAccess.state.kind === "ending"}
                            onClick={pane.remoteAccess.getState().requestEnd}
                        >
                            {remoteAccess.state.kind === "ending" ? "Ending remote access…" : "End remote access"}
                        </Button>
                    )}
                    {remoteAccess.state.kind === "failed" && <p role="alert">{remoteAccess.state.message}</p>}
                </div>
            )}
            <div
                role="log"
                ref={messageList}
                onScroll={(event) => {
                    const element = event.currentTarget;
                    followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                }}
                aria-label="Messages"
                className="min-h-0 flex-1 space-y-8 overflow-y-auto px-4 py-6 [scrollbar-color:#c8d5ce_transparent] [scrollbar-width:thin] sm:px-8 sm:py-10 lg:px-12"
            >
                {model.messages.map((message) => {
                    const workingOnly =
                        message.role === "assistant" &&
                        message.id === presentation.activeMessageId &&
                        message.text.length === 0 &&
                        message.activityIds.length === 0 &&
                        message.contents.length === 0;
                    return (
                        <div
                            key={message.id}
                            className={`mx-auto w-full min-w-0 max-w-[920px] ${workingOnly ? "hidden" : ""}`}
                        >
                            <MobiusSessionMessage
                                message={message}
                                activities={model.activities}
                                activeCommandId={model.activeCommandId}
                                activeMessageId={presentation.activeMessageId}
                                activeUserMessageId={presentation.activeUserMessageId}
                                sessionId={sessionId}
                                botId={botId}
                                client={model.connection.kind === "ready" ? model.connection.client : null}
                            />
                        </div>
                    );
                })}
                <div className="mx-auto w-full min-w-0 max-w-[920px]">
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
            </div>
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
            <BotChatComposer
                actions={
                    <ChatComposerMoreMenu
                        compactAvailable={presentation.compactAvailable}
                        compactDisabled={presentation.compactDisabled}
                        onCompact={() => runAndFollow(pane.store.getState().compact)}
                    />
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
                {delivery.state.kind === "delivery-unknown" && (
                    <div role="alert" className="flex items-center gap-2 text-sm">
                        <span>Delivery unknown. This message will not be sent again automatically.</span>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => run(pane.store.getState().retryUnknownDelivery)}
                        >
                            Retry same message
                        </Button>
                    </div>
                )}
                <ChatConfigurationMenu
                    controls={[
                        {
                            disabled: true,
                            id: "harness",
                            label: "Harness",
                            onValueChange: () => {},
                            options: [{ value: session.agentRef, label: session.agentRef }],
                            value: session.agentRef,
                        },
                        ...model.options
                            .filter(
                                (option) =>
                                    ["model", "thought_level", "model_config"].includes(option.category) &&
                                    option.type !== "boolean",
                            )
                            .map((option) => ({
                                disabled: presentation.busy,
                                id: option.id,
                                label: option.category === "model" ? "Model" : "Variant",
                                onValueChange: (value: string) => configure(option, value),
                                options: option.values.map((value) => ({ value: value.value, label: value.name })),
                                value: option.currentValue,
                            })),
                    ]}
                />
                {model.operation.kind === "configuring" && (
                    <span role="status" className="sr-only">
                        Applying agent settings…
                    </span>
                )}
            </BotChatComposer>
        </section>
    );
}
