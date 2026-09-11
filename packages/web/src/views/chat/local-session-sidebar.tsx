import {
    connectMobiusChannelClient,
    type MobiusChannelClient,
    type NativeSessionEntry,
    type NativeSessionResult,
} from "@moxt-ai/mobius-sdk/channel";
import { Laptop, MessageSquare, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import type { BotChatApi, ChatWorkspace } from "../../services/chat/bot-chat-api.ts";

export interface OpenLocalSession {
    readonly client: MobiusChannelClient;
    readonly agentRef: string;
    readonly result: Extract<NativeSessionResult, { readonly action: "import" | "fork" | "preview" }>;
    readonly entry: NativeSessionEntry;
}
type Directory =
    | { readonly kind: "loading" }
    | { readonly kind: "empty" }
    | {
          readonly kind: "ready";
          readonly client: MobiusChannelClient;
          readonly agentRef: string;
          readonly entries: readonly NativeSessionEntry[];
          readonly nextCursor: string | null;
          readonly sourceSessionId: string;
      }
    | { readonly kind: "failed"; readonly message: string };

export function LocalSessionSidebar({
    botId,
    requests,
    onOpen,
    onChat,
}: {
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "workspace" | "runtimeAccess">;
    readonly onOpen: (session: OpenLocalSession) => void;
    readonly onChat: () => void;
}) {
    const [agents, setAgents] = useState<ChatWorkspace["agents"]>([]);
    const [selected, setSelected] = useState("");
    const [_revision, refresh] = useState(0);
    const [directory, setDirectory] = useState<Directory>({ kind: "loading" });
    const [opening, setOpening] = useState("");
    const [error, setError] = useState("");
    const lifetime = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        let client: MobiusChannelClient | null = null;
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
            const access = await requests.runtimeAccess(botId, agent.runtimeId, controller.signal);
            const endpoint = new URL(access.endpoint);
            if (
                endpoint.username !== "" ||
                endpoint.password !== "" ||
                endpoint.pathname !== "/" ||
                endpoint.search !== "" ||
                endpoint.hash !== "" ||
                (endpoint.protocol !== "https:" &&
                    !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))
            ) {
                throw new Error("The Runtime endpoint is invalid.");
            }
            const url = new URL(`/mobius/api/channels/${encodeURIComponent(access.channelId)}/host`, endpoint);
            url.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
            url.searchParams.set("token", access.hostToken);
            const connected = await connectMobiusChannelClient({ relayUrl: url.href });
            client = connected;
            if (controller.signal.aborted) {
                connected.close();
                return;
            }
            const sourceSessionId = crypto.randomUUID();
            const result = await connected.manageNativeSession(
                {
                    kind: "native.session.request",
                    action: "list",
                    requestId: crypto.randomUUID(),
                    sessionId: sourceSessionId,
                    agentId: agent.agentRef,
                    bindingId: "workspace",
                    directoryId: "default",
                    additionalDirectoryIds: [],
                    cursor: null,
                },
                controller.signal,
            );
            if (result.action !== "list") {
                throw new Error("The agent returned an unexpected session directory.");
            }
            controller.signal.throwIfAborted();
            setDirectory({
                kind: "ready",
                client: connected,
                agentRef: agent.agentRef,
                entries: result.entries,
                nextCursor: result.nextCursor,
                sourceSessionId,
            });
        };
        void open().catch((cause: unknown) => {
            client?.close();
            if (!controller.signal.aborted) {
                setDirectory({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "Local sessions are unavailable.",
                });
            }
        });
        return () => {
            controller.abort();
            client?.close();
        };
    }, [botId, requests, selected]);
    const openEntry = async (entry: NativeSessionEntry) => {
        const controller = lifetime.current;
        if (directory.kind !== "ready" || opening !== "" || controller === null) {
            return;
        }
        setOpening(entry.entryId);
        setError("");
        try {
            const result = await directory.client.manageNativeSession(
                {
                    kind: "native.session.request",
                    action: "import",
                    requestId: crypto.randomUUID(),
                    sessionId: directory.sourceSessionId,
                    targetSessionId: crypto.randomUUID(),
                    agentId: directory.agentRef,
                    bindingId: "workspace",
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
            onOpen({ client: directory.client, agentRef: directory.agentRef, result, entry });
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
            const result = await directory.client.manageNativeSession(
                {
                    kind: "native.session.request",
                    action: "list",
                    requestId: crypto.randomUUID(),
                    sessionId: directory.sourceSessionId,
                    agentId: directory.agentRef,
                    bindingId: "workspace",
                    directoryId: "default",
                    additionalDirectoryIds: [],
                    cursor: directory.nextCursor,
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
    return (
        <aside
            aria-label="Local sessions"
            className="flex w-full shrink-0 flex-col border-b border-border bg-muted/30 p-4 sm:w-64 sm:border-r sm:border-b-0"
        >
            <Button variant="ghost" className="mb-5 justify-start text-foreground" onClick={onChat}>
                <MessageSquare className="size-4" /> My Bot
            </Button>
            <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <Laptop className="size-3.5" /> Local sessions
                </h2>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Refresh local sessions"
                    onClick={() => {
                        onChat();
                        refresh((value) => value + 1);
                    }}
                >
                    <RefreshCw className="size-3.5" />
                </Button>
            </div>
            {agents.length > 0 && (
                <div className="mb-3">
                    <Select
                        label="Session agent"
                        value={selected}
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
            <div className="max-h-48 min-h-0 flex-1 space-y-1 overflow-y-auto sm:max-h-none sm:pb-16">
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
                            onClick={() => void openEntry(entry)}
                            className="group w-full rounded-lg px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none"
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
        </aside>
    );
}
