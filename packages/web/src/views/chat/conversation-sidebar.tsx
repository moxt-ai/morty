import { ChevronDown, Laptop, RefreshCw, Share2, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import { MachineSharing } from "./machine-sharing.tsx";
import { NativeSessionDialog, type OpenMobiusSession } from "./native-session-dialog.tsx";

type Directory =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly sessions: readonly ManagedChatSession[] }
    | { readonly kind: "failed"; readonly message: string };

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
    const [directory, setDirectory] = useState<Directory>({ kind: "loading" });
    const [revision, refresh] = useState(0);
    const [expanded, setExpanded] = useState(false);
    const [dialog, setDialog] = useState(false);
    const [sharing, setSharing] = useState(false);
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
            <Button variant="outline" className="mb-2 justify-start" onClick={() => setDialog(true)}>
                <Laptop className="size-4" aria-hidden="true" />
                Native Sessions
            </Button>
            <Button variant="outline" className="mb-5 justify-start" onClick={() => setSharing(true)}>
                <Share2 className="size-4" aria-hidden="true" />
                Share My Machine
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
