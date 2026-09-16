import type { NativeSessionEntry, NativeSessionResult } from "@moxt-ai/mobius-sdk/channel";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { BotChatApi, ChatWorkspace } from "../../services/chat/bot-chat-api.ts";

export interface OpenLocalSession {
    readonly agentRef: string;
    readonly result: Extract<NativeSessionResult, { readonly ready: unknown }> & { readonly action: "fork" };
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
          readonly entries: readonly NativeSessionEntry[];
          readonly nextCursor: string | null;
      }
    | { readonly kind: "failed"; readonly message: string };
type Selection = { readonly kind: "empty" } | { readonly kind: "selected"; readonly entry: NativeSessionEntry };

export function LocalSessionDialog({
    botId,
    requests,
    onOpen,
    onClose,
}: {
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "workspace" | "nativeSessions">;
    readonly onOpen: (session: OpenLocalSession) => void;
    readonly onClose: () => void;
}) {
    const [agents, setAgents] = useState<ChatWorkspace["agents"]>([]);
    const [selected, setSelected] = useState("");
    const [directory, setDirectory] = useState<Directory>({ kind: "loading" });
    const [selection, setSelection] = useState<Selection>({ kind: "empty" });
    const [operation, setOperation] = useState<"idle" | "more" | "fork">("idle");
    const [error, setError] = useState("");
    const lifetime = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        setDirectory({ kind: "loading" });
        setSelection({ kind: "empty" });
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
        };
    }, [botId, requests, selected]);
    const fork = async () => {
        if (
            directory.kind !== "ready" ||
            selection.kind !== "selected" ||
            operation !== "idle" ||
            lifetime.current === null
        ) {
            return;
        }
        const signal = lifetime.current.signal;
        setOperation("fork");
        setError("");
        try {
            const result = await requests.nativeSessions(
                botId,
                directory.runtimeId,
                {
                    action: "fork",
                    discoveryId: directory.discoveryId,
                    agentId: directory.agentRef,
                    directoryId: selection.entry.directoryId,
                    additionalDirectoryIds: selection.entry.additionalDirectories.map((item) => item.directoryId),
                    entryId: selection.entry.entryId,
                },
                signal,
            );
            signal.throwIfAborted();
            if (result.action !== "fork") {
                throw new Error("This agent cannot fork the selected local session.");
            }
            onOpen({ agentRef: directory.agentRef, result: { ...result, action: "fork" }, entry: selection.entry });
        } catch (cause) {
            if (!signal.aborted) {
                setError(cause instanceof Error ? cause.message : "The session could not be forked.");
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
            description="Select a local session, then fork a copy into Chat."
            onClose={onClose}
            busy={operation === "fork"}
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
                                    aria-pressed={
                                        selection.kind === "selected" && selection.entry.entryId === entry.entryId
                                    }
                                    disabled={operation !== "idle"}
                                    onClick={() => {
                                        setSelection({ kind: "selected", entry });
                                        setError("");
                                    }}
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
                <section aria-label="Selected local session" className="min-w-0 space-y-4 overflow-y-auto p-4 sm:p-6">
                    {selection.kind === "empty" && (
                        <p className="text-muted-foreground">Select a session to fork into Chat.</p>
                    )}
                    {selection.kind === "selected" && (
                        <>
                            <h2 className="font-semibold">{selection.entry.title || "Untitled session"}</h2>
                            <p className="text-muted-foreground">{selection.entry.directoryLabel}</p>
                            <p>The original local session will remain unchanged.</p>
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
                <Button variant="outline" disabled={operation === "fork"} onClick={onClose}>
                    Cancel
                </Button>
                <Button
                    data-testid={dataTestId.forkLocalSession}
                    disabled={selection.kind !== "selected" || operation !== "idle"}
                    onClick={() => void fork()}
                >
                    {operation === "fork" ? "Forking…" : "Fork"}
                </Button>
            </footer>
        </Dialog>
    );
}
