import { ChevronDown, Laptop, MessageSquare, RefreshCw, Share2, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import { createConversationDirectoryStore } from "../../view-models/chat/conversation-directory-store.ts";
import { MachineSharing } from "./machine-sharing.tsx";
import { NativeSessionDialog, type OpenMobiusSession } from "./native-session-dialog.tsx";

export function ConversationSidebar({
    botId,
    requests,
    activeId,
    onOpen,
    onOpenSession,
    onNewConversation,
    createTransfer,
}: {
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "workspace" | "nativeSessions" | "nativeSession" | "managedSessions">;
    readonly activeId: string;
    readonly onOpen: (session: ManagedChatSession) => void;
    readonly onOpenSession: (session: OpenMobiusSession) => void;
    readonly onNewConversation: () => void;
    readonly createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>;
}) {
    const [store] = useState(() => createConversationDirectoryStore(botId, requests));
    const { load, state: directory } = useStore(store);
    const [revision, refresh] = useState(0);
    const [expanded, setExpanded] = useState(false);
    const [dialog, setDialog] = useState(false);
    const [sharing, setSharing] = useState(false);
    const sessions =
        directory.kind === "ready" || directory.kind === "refreshing" || directory.kind === "stale"
            ? directory.sessions
            : null;
    const refreshing = directory.kind === "refreshing";
    // biome-ignore lint/correctness/useExhaustiveDependencies: Creation and explicit refresh reload the persisted directory.
    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [activeId, load, revision]);
    return (
        <aside
            aria-label="Workspace navigation"
            className="flex min-h-0 w-full shrink-0 flex-col overflow-hidden border-b border-border/80 bg-sidebar px-3 py-3 sm:w-[280px] sm:border-r sm:border-b-0 sm:px-3.5 sm:py-4"
        >
            <div className="mb-4 flex items-center gap-3 px-1.5 sm:mb-6">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_4px_12px_rgba(34,123,78,0.18)]">
                    <MessageSquare className="size-[18px]" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                    <h1 className="truncate text-[15px] leading-5 font-semibold tracking-[-0.015em]">Mobius Chat</h1>
                    <span className="block text-[11px] leading-4 text-muted-foreground">Local workspace</span>
                </span>
            </div>
            <Button
                className="mb-2 min-h-10 justify-start rounded-xl shadow-[0_3px_10px_rgba(34,123,78,0.14)]"
                onClick={onNewConversation}
                data-testid={dataTestId.newConversation}
            >
                <SquarePen className="size-4" aria-hidden="true" />
                New Conversation
            </Button>
            <Button
                variant="ghost"
                className="mb-4 min-h-10 justify-start rounded-xl px-3 text-copy-secondary hover:bg-white/70 sm:mb-6"
                onClick={() => setDialog(true)}
            >
                <Laptop className="size-4" aria-hidden="true" />
                Native Sessions
            </Button>
            <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="hidden text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:block">
                    Conversations
                </h2>
                <Button
                    variant="ghost"
                    className="justify-start sm:hidden"
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
                    className="size-8 rounded-lg"
                    aria-label={refreshing ? "Refreshing conversations" : "Refresh conversations"}
                    aria-busy={refreshing}
                    disabled={refreshing}
                    onClick={() => refresh((value) => value + 1)}
                >
                    <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`} />
                </Button>
            </div>
            <div
                id="chat-conversations"
                className={`${expanded ? "block" : "hidden"} max-h-48 min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5 sm:block sm:max-h-none`}
            >
                {directory.kind === "loading" && <p role="status">Loading conversations…</p>}
                {(directory.kind === "failed" || directory.kind === "stale") && (
                    <p role="alert" className="text-sm text-destructive">
                        {directory.message}
                    </p>
                )}
                {sessions !== null && sessions.length === 0 && (
                    <p className="px-2 py-3 text-xs text-muted-foreground">Your Chat conversations will appear here.</p>
                )}
                {sessions?.map((session) => (
                    <button
                        type="button"
                        key={`${session.kind}:${session.id}`}
                        aria-current={activeId === session.id ? "page" : undefined}
                        onClick={() => {
                            onOpen(session);
                            setExpanded(false);
                        }}
                        className="w-full truncate rounded-xl border border-transparent px-3 py-2.5 text-left text-[13px] font-medium text-copy-secondary outline-none transition-[background-color,color,box-shadow] duration-150 hover:bg-white/70 focus-visible:ring-2 focus-visible:ring-ring/60 aria-[current=page]:bg-white aria-[current=page]:text-foreground aria-[current=page]:shadow-[0_1px_4px_rgba(17,24,20,0.08),inset_3px_0_0_var(--primary)] motion-reduce:transition-none"
                    >
                        {session.title}
                    </button>
                ))}
            </div>
            <div className="mt-3 border-t border-black/[0.06] pt-3">
                <Button
                    variant="ghost"
                    className="w-full min-h-10 justify-start rounded-xl px-3 text-copy-secondary hover:bg-white/70"
                    onClick={() => setSharing(true)}
                >
                    <Share2 className="size-4" aria-hidden="true" />
                    Share My Machine
                </Button>
            </div>
            {dialog && (
                <NativeSessionDialog
                    botId={botId}
                    requests={requests}
                    onClose={() => setDialog(false)}
                    onOpen={(session) => {
                        onOpenSession(session);
                        setDialog(false);
                        refresh((value) => value + 1);
                    }}
                />
            )}
            {sharing && (
                <Dialog
                    title="Share My Machine"
                    description="Scan the QR code or open the link on another device to use this workspace."
                    onClose={() => setSharing(false)}
                >
                    <MachineSharing createTransfer={createTransfer} />
                </Dialog>
            )}
        </aside>
    );
}
