import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { AgentMarkdown } from "../../components/agents/agent-markdown.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { createNativeSessionStore } from "../../view-models/chat/native-session-store.ts";
import type { OpenMobiusSession } from "../../view-models/chat/open-session.ts";

export type { OpenMobiusSession } from "../../view-models/chat/open-session.ts";

export function NativeSessionDialog({
    botId,
    requests,
    onOpen,
    onClose,
}: {
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "workspace" | "nativeSessions" | "nativeSession">;
    readonly onOpen: (session: OpenMobiusSession) => void;
    readonly onClose: () => void;
}) {
    const [store] = useState(() => createNativeSessionStore(botId, requests, onOpen));
    const model = useStore(store);
    const lifetime = useRef<AbortController | null>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Selecting an agent explicitly restarts discovery.
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void store.getState().load(controller.signal);
        return () => {
            controller.abort();
            store.getState().dispose();
            if (lifetime.current === controller) {
                lifetime.current = null;
            }
        };
    }, [model.selected, store]);
    const withSignal = (action: (signal: AbortSignal) => Promise<void>) => {
        const controller = lifetime.current;
        if (controller !== null) {
            void action(controller.signal);
        }
    };
    const fallback = model.agents.find((agent) => agent.online);
    return (
        <Dialog
            title="Native Sessions"
            description="Select a native agent session to preview it, then import it or fork it as a Mobius Session."
            onClose={onClose}
            busy={model.operation === "import" || model.operation === "fork"}
            wide
        >
            <div className="grid h-[min(60dvh,36rem)] min-h-0 grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)] overflow-hidden rounded-xl border border-border">
                <section
                    aria-label="Native sessions"
                    className="flex min-h-0 flex-col gap-3 border-r border-border bg-muted/30 p-3"
                >
                    <h2 className="font-semibold">Native Session</h2>
                    {model.agents.length > 0 && (
                        <Select
                            label="Session agent"
                            value={
                                model.selected ||
                                (fallback === undefined ? "" : `${fallback.runtimeId}:${fallback.agentRef}`)
                            }
                            disabled={model.operation !== "idle"}
                            options={model.agents.map((agent) => ({
                                value: `${agent.runtimeId}:${agent.agentRef}`,
                                label: `${agent.label} · ${agent.machineName}`,
                            }))}
                            onValueChange={store.getState().selectAgent}
                        />
                    )}
                    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                        {model.directory.kind === "loading" && <p role="status">Discovering native sessions…</p>}
                        {model.directory.kind === "empty" && <p>Connect a local agent to browse its sessions.</p>}
                        {model.directory.kind === "failed" && <p role="alert">{model.directory.message}</p>}
                        {model.directory.kind === "ready" && model.directory.entries.length === 0 && (
                            <p>No saved sessions were reported by this agent.</p>
                        )}
                        {model.directory.kind === "ready" &&
                            model.directory.entries.map((entry) => (
                                <button
                                    type="button"
                                    key={entry.entryId}
                                    data-testid={dataTestId.localSessionEntry}
                                    aria-label={entry.title || "Untitled session"}
                                    aria-pressed={
                                        model.preview.kind !== "empty" && model.preview.entry.entryId === entry.entryId
                                    }
                                    disabled={model.operation !== "idle"}
                                    onClick={() =>
                                        withSignal(async (signal) => await store.getState().select(entry, signal))
                                    }
                                    className="w-full rounded-lg p-3 text-left hover:bg-muted focus-visible:outline-ring aria-pressed:bg-primary/10"
                                >
                                    <span className="block truncate font-medium">
                                        {entry.title || "Untitled session"}
                                    </span>
                                    <span className="block truncate text-xs text-muted-foreground">
                                        {entry.directoryLabel}
                                    </span>
                                </button>
                            ))}
                        {model.directory.kind === "ready" && model.directory.nextCursor !== null && (
                            <Button
                                variant="ghost"
                                disabled={model.operation !== "idle"}
                                onClick={() => withSignal(store.getState().more)}
                            >
                                Load more
                            </Button>
                        )}
                    </div>
                </section>
                <section aria-label="Selected session preview" className="min-w-0 space-y-4 overflow-y-auto p-4 sm:p-6">
                    {model.preview.kind === "empty" && (
                        <p className="text-muted-foreground">Select a session to preview its history.</p>
                    )}
                    {model.preview.kind === "loading" && <p role="status">Loading session preview…</p>}
                    {model.preview.kind === "failed" && (
                        <p role="alert" className="text-destructive">
                            {model.preview.message}
                        </p>
                    )}
                    {model.preview.kind === "ready" && (
                        <>
                            <h2 className="font-semibold">
                                {model.preview.content.title || model.preview.entry.title || "Untitled session"}
                            </h2>
                            {model.preview.content.history.status === "unavailable" ? (
                                <p>{model.preview.content.history.cause.message}</p>
                            ) : (
                                <>
                                    {model.preview.content.history.messages.length === 0 && (
                                        <p>No messages in this session.</p>
                                    )}
                                    {model.preview.content.history.messages.map((message, index) => (
                                        <div
                                            // biome-ignore lint/suspicious/noArrayIndexKey: Native history has no message IDs; this read-only snapshot never reorders messages.
                                            key={`${index}-${message.role}`}
                                            className={`break-words rounded-xl p-3 ${message.role === "user" ? "ml-6 bg-primary/10" : "mr-6 bg-muted"}`}
                                        >
                                            <AgentMarkdown
                                                className="[&_p]:my-0"
                                                markdown={message.text}
                                                streaming={false}
                                            />
                                        </div>
                                    ))}
                                    {model.preview.content.history.truncated && (
                                        <p className="text-muted-foreground">Showing a partial history preview.</p>
                                    )}
                                </>
                            )}
                        </>
                    )}
                </section>
            </div>
            <footer className="mt-5 flex justify-end gap-2">
                <Button
                    variant="outline"
                    disabled={model.operation === "import" || model.operation === "fork"}
                    onClick={onClose}
                >
                    Cancel
                </Button>
                <Button
                    data-testid={dataTestId.importLocalSession}
                    variant="outline"
                    disabled={
                        model.preview.kind !== "ready" ||
                        model.operation !== "idle" ||
                        model.directory.kind !== "ready" ||
                        (!model.directory.capabilities.loadSession && !model.directory.capabilities.resumeSession)
                    }
                    onClick={() => withSignal(async (signal) => await store.getState().open("import", signal))}
                >
                    {model.operation === "import" ? "Importing…" : "Import"}
                </Button>
                <Button
                    data-testid={dataTestId.forkLocalSession}
                    disabled={model.preview.kind !== "ready" || model.operation !== "idle"}
                    onClick={() => withSignal(async (signal) => await store.getState().open("fork", signal))}
                >
                    {model.operation === "fork" ? "Forking…" : "Fork"}
                </Button>
            </footer>
            {model.error !== "" &&
                createPortal(
                    <div
                        className="fixed right-4 bottom-4 z-[70] max-w-sm rounded-xl border border-destructive/20 bg-white px-4 py-3 text-sm text-destructive shadow-lg"
                        role="alert"
                    >
                        {model.error}
                    </div>,
                    document.body,
                )}
        </Dialog>
    );
}
