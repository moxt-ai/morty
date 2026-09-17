import type { NativeSessionEntry, NativeSessionResult } from "@moxt-ai/mobius-sdk/channel";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { BotChatApi, ChatWorkspace } from "../../services/chat/bot-chat-api.ts";

export interface OpenLocalSession {
    readonly agentRef: string;
    readonly result: Extract<NativeSessionResult, { readonly ready: unknown }>;
    readonly entry: NativeSessionEntry;
}
type Directory =
    | { readonly kind: "loading" }
    | { readonly kind: "empty" }
    | {
          readonly kind: "ready";
          readonly runtimeId: string;
          readonly discoveryId: string;
          readonly agentRef: string;
          readonly capabilities: Extract<NativeSessionResult, { readonly action: "list" }>["capabilities"];
          readonly entries: readonly NativeSessionEntry[];
          readonly nextCursor: string | null;
      }
    | { readonly kind: "failed"; readonly message: string };
type Preview =
    | { readonly kind: "empty" }
    | { readonly kind: "loading"; readonly entry: NativeSessionEntry }
    | {
          readonly kind: "ready";
          readonly entry: NativeSessionEntry;
          readonly content: Awaited<ReturnType<BotChatApi["nativeSession"]>>;
      }
    | { readonly kind: "failed"; readonly entry: NativeSessionEntry; readonly message: string };

export function LocalSessionDialog({
    botId,
    requests,
    onOpen,
    onClose,
}: {
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "workspace" | "nativeSessions" | "nativeSession">;
    readonly onOpen: (session: OpenLocalSession) => void;
    readonly onClose: () => void;
}) {
    const [agents, setAgents] = useState<ChatWorkspace["agents"]>([]);
    const [selected, setSelected] = useState("");
    const [directory, setDirectory] = useState<Directory>({ kind: "loading" });
    const [preview, setPreview] = useState<Preview>({ kind: "empty" });
    const [operation, setOperation] = useState<"idle" | "more" | "import" | "fork">("idle");
    const [error, setError] = useState("");
    const lifetime = useRef<AbortController | null>(null);
    const selection = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        setDirectory({ kind: "loading" });
        setPreview({ kind: "empty" });
        setError("");
        const open = async () => {
            const workspace = await requests.workspace(botId, controller.signal);
            controller.signal.throwIfAborted();
            setAgents(workspace.agents);
            const agent =
                workspace.agents.find((item) => `${item.runtimeId}:${item.agentRef}` === selected) ??
                workspace.agents.find((item) => item.online);
            if (agent === undefined) {
                setDirectory({ kind: "empty" });
                return;
            }
            const result = await requests.nativeSessions(
                botId,
                agent.runtimeId,
                {
                    action: "list",
                    agentId: agent.agentRef,
                    directoryId: "default",
                    additionalDirectoryIds: [],
                    cursor: null,
                    discoveryId: null,
                },
                controller.signal,
            );
            controller.signal.throwIfAborted();
            if (result.action !== "list") {
                throw new Error("The agent returned an unexpected session directory.");
            }
            setDirectory({
                kind: "ready",
                runtimeId: agent.runtimeId,
                discoveryId: result.sessionId,
                agentRef: agent.agentRef,
                capabilities: result.capabilities,
                entries: result.entries,
                nextCursor: result.nextCursor,
            });
        };
        void open().catch((cause: unknown) => {
            if (!controller.signal.aborted) {
                setDirectory({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "Local sessions are unavailable.",
                });
            }
        });
        return () => {
            controller.abort();
            selection.current?.abort();
        };
    }, [botId, requests, selected]);
    const select = async (entry: NativeSessionEntry) => {
        if (directory.kind !== "ready" || operation !== "idle" || lifetime.current === null) {
            return;
        }
        selection.current?.abort();
        const controller = new AbortController();
        selection.current = controller;
        const signal = AbortSignal.any([controller.signal, lifetime.current.signal]);
        setPreview({ kind: "loading", entry });
        setError("");
        try {
            const content = await requests.nativeSession(
                botId,
                directory.runtimeId,
                {
                    discoveryId: directory.discoveryId,
                    agentId: directory.agentRef,
                    directoryId: entry.directoryId,
                    additionalDirectoryIds: entry.additionalDirectories.map((item) => item.directoryId),
                    entryId: entry.entryId,
                },
                signal,
            );
            signal.throwIfAborted();
            setPreview({ kind: "ready", entry, content });
        } catch (cause) {
            if (!signal.aborted) {
                setPreview({
                    kind: "failed",
                    entry,
                    message: cause instanceof Error ? cause.message : "The preview could not be loaded.",
                });
            }
        }
    };
    const openSession = async (action: "import" | "fork") => {
        if (
            directory.kind !== "ready" ||
            preview.kind !== "ready" ||
            operation !== "idle" ||
            lifetime.current === null
        ) {
            return;
        }
        const signal = lifetime.current.signal;
        setOperation(action);
        setError("");
        try {
            const result = await requests.nativeSessions(
                botId,
                directory.runtimeId,
                {
                    action,
                    discoveryId: directory.discoveryId,
                    agentId: directory.agentRef,
                    directoryId: preview.entry.directoryId,
                    additionalDirectoryIds: preview.entry.additionalDirectories.map((item) => item.directoryId),
                    entryId: preview.entry.entryId,
                },
                signal,
            );
            signal.throwIfAborted();
            if (result.action !== action) {
                throw new Error(`This agent cannot ${action} the selected local session.`);
            }
            onOpen({ agentRef: directory.agentRef, result, entry: preview.entry });
        } catch (cause) {
            if (!signal.aborted) {
                setError(cause instanceof Error ? cause.message : `The session could not be ${action}ed.`);
            }
        } finally {
            if (!signal.aborted) {
                setOperation("idle");
            }
        }
    };
    const more = async () => {
        if (
            directory.kind !== "ready" ||
            directory.nextCursor === null ||
            operation !== "idle" ||
            lifetime.current === null
        ) {
            return;
        }
        const signal = lifetime.current.signal;
        setOperation("more");
        setError("");
        try {
            const result = await requests.nativeSessions(
                botId,
                directory.runtimeId,
                {
                    action: "list",
                    agentId: directory.agentRef,
                    directoryId: "default",
                    additionalDirectoryIds: [],
                    cursor: directory.nextCursor,
                    discoveryId: directory.discoveryId,
                },
                signal,
            );
            signal.throwIfAborted();
            if (result.action !== "list") {
                throw new Error("The agent returned an unexpected session directory.");
            }
            setDirectory({
                ...directory,
                entries: [
                    ...directory.entries,
                    ...result.entries.filter(
                        (entry) => !directory.entries.some((existing) => existing.entryId === entry.entryId),
                    ),
                ],
                nextCursor: result.nextCursor,
            });
        } catch (cause) {
            if (!signal.aborted) {
                setError(cause instanceof Error ? cause.message : "More sessions could not be loaded.");
            }
        } finally {
            if (!signal.aborted) {
                setOperation("idle");
            }
        }
    };
    const fallback = agents.find((agent) => agent.online);
    return (
        <Dialog
            title="Open Local Session"
            description="Select a local session to preview its history, then import or fork it into Chat."
            onClose={onClose}
            busy={operation === "import" || operation === "fork"}
            wide
        >
            <div className="grid h-[min(60dvh,36rem)] min-h-0 grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)] overflow-hidden rounded-xl border border-border">
                <section
                    aria-label="Local sessions"
                    className="flex min-h-0 flex-col gap-3 border-r border-border bg-muted/30 p-3"
                >
                    <h2 className="font-semibold">Local Session</h2>
                    {agents.length > 0 && (
                        <Select
                            label="Session agent"
                            value={
                                selected || (fallback === undefined ? "" : `${fallback.runtimeId}:${fallback.agentRef}`)
                            }
                            disabled={operation !== "idle"}
                            options={agents.map((agent) => ({
                                value: `${agent.runtimeId}:${agent.agentRef}`,
                                label: `${agent.label} · ${agent.machineName}`,
                            }))}
                            onValueChange={setSelected}
                        />
                    )}
                    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                        {directory.kind === "loading" && <p role="status">Discovering local sessions…</p>}
                        {directory.kind === "empty" && <p>Connect a local agent to browse its sessions.</p>}
                        {directory.kind === "failed" && <p role="alert">{directory.message}</p>}
                        {directory.kind === "ready" && directory.entries.length === 0 && (
                            <p>No saved sessions were reported by this agent.</p>
                        )}
                        {directory.kind === "ready" &&
                            directory.entries.map((entry) => (
                                <button
                                    type="button"
                                    key={entry.entryId}
                                    data-testid={dataTestId.localSessionEntry}
                                    aria-label={entry.title || "Untitled session"}
                                    aria-pressed={preview.kind !== "empty" && preview.entry.entryId === entry.entryId}
                                    disabled={operation !== "idle"}
                                    onClick={() => void select(entry)}
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
                        {directory.kind === "ready" && directory.nextCursor !== null && (
                            <Button variant="ghost" disabled={operation !== "idle"} onClick={() => void more()}>
                                Load more
                            </Button>
                        )}
                    </div>
                </section>
                <section aria-label="Selected session preview" className="min-w-0 space-y-4 overflow-y-auto p-4 sm:p-6">
                    {preview.kind === "empty" && (
                        <p className="text-muted-foreground">Select a session to preview its history.</p>
                    )}
                    {preview.kind === "loading" && <p role="status">Loading session preview…</p>}
                    {preview.kind === "failed" && (
                        <p role="alert" className="text-destructive">
                            {preview.message}
                        </p>
                    )}
                    {preview.kind === "ready" && (
                        <>
                            <h2 className="font-semibold">
                                {preview.content.title || preview.entry.title || "Untitled session"}
                            </h2>
                            {preview.content.history.status === "unavailable" ? (
                                <p>This agent does not expose saved message history.</p>
                            ) : (
                                <>
                                    {preview.content.history.messages.length === 0 && (
                                        <p>No messages in this session.</p>
                                    )}
                                    {preview.content.history.messages.map((message, index) => (
                                        <div
                                            // biome-ignore lint/suspicious/noArrayIndexKey: Native history has no message IDs; this read-only snapshot never reorders messages.
                                            key={`${index}-${message.role}`}
                                            className={`whitespace-pre-wrap break-words rounded-xl p-3 ${message.role === "user" ? "ml-6 bg-primary/10" : "mr-6 bg-muted"}`}
                                        >
                                            {message.text}
                                        </div>
                                    ))}
                                    {preview.content.history.truncated && (
                                        <p className="text-muted-foreground">Showing a partial history preview.</p>
                                    )}
                                </>
                            )}
                        </>
                    )}
                </section>
            </div>
            {error !== "" && (
                <p role="alert" className="mt-3 text-destructive">
                    {error}
                </p>
            )}
            <footer className="mt-5 flex justify-end gap-2">
                <Button variant="outline" disabled={operation === "import" || operation === "fork"} onClick={onClose}>
                    Cancel
                </Button>
                <Button
                    data-testid={dataTestId.importLocalSession}
                    variant="outline"
                    disabled={
                        preview.kind !== "ready" ||
                        operation !== "idle" ||
                        directory.kind !== "ready" ||
                        (!directory.capabilities.loadSession && !directory.capabilities.resumeSession)
                    }
                    onClick={() => void openSession("import")}
                >
                    {operation === "import" ? "Importing…" : "Import"}
                </Button>
                <Button
                    data-testid={dataTestId.forkLocalSession}
                    disabled={preview.kind !== "ready" || operation !== "idle"}
                    onClick={() => void openSession("fork")}
                >
                    {operation === "fork" ? "Forking…" : "Fork"}
                </Button>
            </footer>
        </Dialog>
    );
}
