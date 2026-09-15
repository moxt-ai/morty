import { ChevronDown, Laptop, RefreshCw, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import { LocalSessionDialog, type OpenLocalSession } from "./local-session-dialog.tsx";

type Directory =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly sessions: readonly ManagedChatSession[] }
    | { readonly kind: "failed"; readonly message: string };

export function ConversationSidebar({
    botId,
    requests,
    activeId,
    onOpen,
    onFork,
    onNewConversation,
}: {
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "workspace" | "nativeSessions" | "nativeSession" | "managedSessions">;
    readonly activeId: string;
    readonly onOpen: (session: ManagedChatSession) => void;
    readonly onFork: (session: OpenLocalSession) => void;
    readonly onNewConversation: () => void;
}) {
    const [directory, setDirectory] = useState<Directory>({ kind: "loading" });
    const [revision, refresh] = useState(0);
    const [expanded, setExpanded] = useState(false);
    const [dialog, setDialog] = useState(false);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Creation and explicit refresh reload the persisted directory.
    useEffect(() => {
        const controller = new AbortController();
        void requests
            .managedSessions(botId, controller.signal)
            .then((sessions) => {
                if (!controller.signal.aborted) {
                    setDirectory({ kind: "ready", sessions });
                }
            })
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    setDirectory({
                        kind: "failed",
                        message: cause instanceof Error ? cause.message : "Conversations are unavailable.",
                    });
                }
            });
        return () => controller.abort();
    }, [botId, requests, activeId, revision]);
    return (
        <aside
            aria-label="Conversations"
            className="flex min-h-0 w-full shrink-0 flex-col overflow-hidden border-b border-border bg-[#edf2ef] p-4 sm:w-64 sm:border-r sm:border-b-0 sm:pb-20"
        >
            <Button
                className="mb-2 justify-start shadow-sm"
                onClick={onNewConversation}
                data-testid={dataTestId.newConversation}
            >
                <SquarePen className="size-4" aria-hidden="true" />
                New Conversation
            </Button>
            <Button variant="outline" className="mb-5 justify-start" onClick={() => setDialog(true)}>
                <Laptop className="size-4" aria-hidden="true" />
                Open Local Session
            </Button>
            <div className="mb-3 flex items-center justify-between">
                <h2 className="hidden text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:block">
                    Conversations
                </h2>
                <Button
                    variant="ghost"
                    className="sm:hidden"
                    aria-expanded={expanded}
                    aria-controls="chat-conversations"
                    onClick={() => setExpanded((value) => !value)}
                >
                    Conversations
                    <ChevronDown className="size-4" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Refresh conversations"
                    onClick={() => refresh((value) => value + 1)}
                >
                    <RefreshCw className="size-3.5" />
                </Button>
            </div>
            <div
                id="chat-conversations"
                className={`${expanded ? "block" : "hidden"} max-h-48 min-h-0 flex-1 space-y-1 overflow-y-auto sm:block sm:max-h-none`}
            >
                {directory.kind === "loading" && <p role="status">Loading conversations…</p>}
                {directory.kind === "failed" && (
                    <p role="alert" className="text-sm text-destructive">
                        {directory.message}
                    </p>
                )}
                {directory.kind === "ready" && directory.sessions.length === 0 && (
                    <p className="px-2 py-3 text-xs text-muted-foreground">Your Chat conversations will appear here.</p>
                )}
                {directory.kind === "ready" &&
                    directory.sessions.map((session) => (
                        <button
                            type="button"
                            key={`${session.kind}:${session.id}`}
                            aria-current={activeId === session.id ? "page" : undefined}
                            onClick={() => {
                                onOpen(session);
                                setExpanded(false);
                            }}
                            className="w-full truncate rounded-xl border border-transparent px-3 py-3 text-left text-sm font-medium text-copy-secondary hover:bg-white/70 focus-visible:outline-ring aria-[current=page]:border-primary/15 aria-[current=page]:bg-white aria-[current=page]:text-primary"
                        >
                            {session.title}
                        </button>
                    ))}
            </div>
            {dialog && (
                <LocalSessionDialog
                    botId={botId}
                    requests={requests}
                    onClose={() => setDialog(false)}
                    onOpen={(session) => {
                        onFork(session);
                        setDialog(false);
                        refresh((value) => value + 1);
                    }}
                />
            )}
        </aside>
    );
}
