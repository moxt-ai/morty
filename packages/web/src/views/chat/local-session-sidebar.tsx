import type { NativeSessionEntry, NativeSessionResult } from "@moxt-ai/mobius-sdk/channel";
import { ChevronDown, Laptop, RefreshCw, SquarePen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import type { BotChatApi, ChatWorkspace } from "../../services/chat/bot-chat-api.ts";

export interface OpenLocalSession {
    readonly agentRef: string;
    readonly result: Extract<NativeSessionResult, { readonly action: "import" | "fork" | "preview" }>;
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

export function LocalSessionSidebar({
    botId,
    requests,
    onOpen,
    onChat,
    onNewConversation,
    activeEntryId,
}: {
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "workspace" | "nativeSessions">;
    readonly onOpen: (session: OpenLocalSession) => void;
    readonly onChat: () => void;
    readonly onNewConversation: () => void;
    readonly activeEntryId: string;
}) {
    const [agents, setAgents] = useState<ChatWorkspace["agents"]>([]);
    const [selected, setSelected] = useState("");
    const [mobileExpanded, setMobileExpanded] = useState(false);
    const [revision, refresh] = useState(0);
    const [directory, setDirectory] = useState<Directory>({ kind: "loading" });
    const [opening, setOpening] = useState("");
    const [error, setError] = useState("");
    const lifetime = useRef<AbortController | null>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh reopens the Runtime session directory.
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        const open = async () => {
            setDirectory({ kind: "loading" });
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
            if (result.action !== "list") {
                throw new Error("The agent returned an unexpected session directory.");
            }
            controller.signal.throwIfAborted();
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
    }, [botId, requests, selected, revision]);
    const openEntry = async (entry: NativeSessionEntry) => {
        const controller = lifetime.current;
        if (directory.kind !== "ready" || opening !== "" || controller === null) {
            return;
        }
        setOpening(entry.entryId);
        setError("");
        try {
            const result = await requests.nativeSessions(
                botId,
                directory.runtimeId,
                {
                    action: "import",
                    discoveryId: directory.discoveryId,
                    agentId: directory.agentRef,
                    directoryId: entry.directoryId,
                    additionalDirectoryIds: entry.additionalDirectories.map((item) => item.directoryId),
                    entryId: entry.entryId,
                },
                AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
            );
            if (result.action !== "import" && result.action !== "preview") {
                throw new Error("The agent returned an unexpected session.");
            }
            controller.signal.throwIfAborted();
            onOpen({
                agentRef: directory.agentRef,
                result,
                entry,
            });
            setMobileExpanded(false);
        } catch (cause) {
            if (!controller.signal.aborted) {
                setError(cause instanceof Error ? cause.message : "The session could not be opened.");
            }
        } finally {
            if (!controller.signal.aborted) {
                setOpening("");
            }
        }
    };
    const more = async () => {
        const controller = lifetime.current;
        if (directory.kind !== "ready" || directory.nextCursor === null || opening !== "" || controller === null) {
            return;
        }
        setOpening("more");
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
                AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
            );
            if (result.action !== "list") {
                throw new Error("The agent returned an unexpected session directory.");
            }
            controller.signal.throwIfAborted();
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
            if (!controller.signal.aborted) {
                setError(cause instanceof Error ? cause.message : "More sessions could not be loaded.");
            }
        } finally {
            if (!controller.signal.aborted) {
                setOpening("");
            }
        }
    };
    const fallbackAgent = agents.find((agent) => agent.online);
    const agentValue =
        selected || (fallbackAgent === undefined ? "" : `${fallbackAgent.runtimeId}:${fallbackAgent.agentRef}`);
    return (
        <aside
            aria-label="Local sessions"
            className="flex min-h-0 w-full shrink-0 flex-col overflow-hidden border-b border-border bg-[#edf2ef] p-4 sm:w-64 sm:border-r sm:border-b-0 sm:pb-20"
        >
            <Button className="mb-6 justify-start shadow-sm" disabled={opening !== ""} onClick={onNewConversation}>
                <SquarePen className="size-4" aria-hidden="true" /> New Conversation
            </Button>
            <div className="mb-3 flex items-center justify-between">
                <h2 className="hidden items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:flex">
                    <Laptop className="size-3.5" /> Local sessions
                </h2>
                <Button
                    variant="ghost"
                    className="gap-2 sm:hidden"
                    aria-expanded={mobileExpanded}
                    aria-controls="local-session-directory"
                    onClick={() => setMobileExpanded((value) => !value)}
                >
                    <Laptop className="size-3.5" /> Local sessions{" "}
                    <ChevronDown
                        className={`size-3.5 transition-transform motion-reduce:transition-none ${mobileExpanded ? "rotate-180" : ""}`}
                    />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Refresh local sessions"
                    disabled={opening !== "" || directory.kind === "loading"}
                    onClick={() => {
                        onChat();
                        refresh((value) => value + 1);
                    }}
                >
                    <RefreshCw className="size-3.5" />
                </Button>
            </div>
            <div
                id="local-session-directory"
                className={`${mobileExpanded ? "flex" : "hidden"} min-h-0 flex-1 flex-col sm:flex`}
            >
                {agents.length > 0 && (
                    <div className="mb-3">
                        <Select
                            label="Session agent"
                            value={agentValue}
                            disabled={opening !== "" || directory.kind === "loading"}
                            options={agents.map((agent) => ({
                                value: `${agent.runtimeId}:${agent.agentRef}`,
                                label: `${agent.label} · ${agent.machineName}`,
                            }))}
                            onValueChange={(value) => {
                                onChat();
                                setSelected(value);
                            }}
                        />
                    </div>
                )}
                <div className="max-h-48 min-h-0 flex-1 space-y-1 overflow-y-auto sm:max-h-none">
                    {directory.kind === "loading" && (
                        <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
                            Discovering local sessions…
                        </p>
                    )}
                    {directory.kind === "empty" && (
                        <p className="px-2 py-3 text-xs leading-5 text-muted-foreground">
                            Connect a local agent to see its sessions here.
                        </p>
                    )}
                    {directory.kind === "failed" && (
                        <p role="alert" className="px-2 py-3 text-xs leading-5 text-destructive">
                            {directory.message}
                        </p>
                    )}
                    {directory.kind === "ready" && directory.entries.length === 0 && (
                        <p className="px-2 py-3 text-xs leading-5 text-muted-foreground">
                            No saved sessions were reported by this agent.
                        </p>
                    )}
                    {directory.kind === "ready" &&
                        directory.entries.map((entry) => (
                            <button
                                type="button"
                                key={entry.entryId}
                                disabled={opening !== ""}
                                aria-current={activeEntryId === entry.entryId ? "page" : undefined}
                                onClick={() => void openEntry(entry)}
                                className={`group w-full rounded-xl border px-3 py-3 text-left outline-none transition-colors hover:bg-white/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none ${activeEntryId === entry.entryId ? "border-primary/15 bg-white text-primary shadow-sm" : "border-transparent text-copy-secondary"}`}
                            >
                                <span className="block truncate text-sm font-medium">
                                    {opening === entry.entryId ? "Opening…" : entry.title || "Untitled session"}
                                </span>
                                <span className="mt-1 block truncate text-xs text-muted-foreground">
                                    {entry.directoryLabel}
                                </span>
                            </button>
                        ))}
                    {directory.kind === "ready" && directory.nextCursor !== null && (
                        <Button variant="ghost" disabled={opening !== ""} onClick={() => void more()}>
                            Load more
                        </Button>
                    )}
                    {error !== "" && (
                        <p role="alert" className="p-2 text-xs text-destructive">
                            {error}
                        </p>
                    )}
                </div>
            </div>
        </aside>
    );
}
