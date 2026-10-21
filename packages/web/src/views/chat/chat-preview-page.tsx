import { Laptop, List, MessageSquare, RefreshCw, Share2, SquarePen, UserRound, Wifi } from "lucide-react";
import { Tooltip } from "radix-ui";
import { type ReactNode, useRef, useState } from "react";
import { useStore } from "zustand";
import { BotChatComposer } from "../../components/chat/bot-chat-composer.tsx";
import { UserPromptMessage } from "../../components/chat/user-prompt-message.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { MortyTooltipContent } from "../../components/ui/morty-tooltip-content.tsx";
import { FollowLatestScrollArea } from "../../components/utils/follow-latest-scroll-area.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { BotConnectionStatus } from "../../view-models/chat/bot-chat-home-store.ts";
import { createComposerAttachmentStore } from "../../view-models/chat/composer-attachment-store.ts";
import { SetupCardDescription, SetupCardLogo, SetupCardShell, SetupCardTitle } from "../setup/setup-card-shell.tsx";
import type { ChatPreviewStateId } from "./chat-preview.ts";
import { InteractiveChatPreview } from "./chat-preview-interactive.tsx";
import { MobiusAssistantText } from "./mobius-session-message.tsx";
import {
    MobiusSessionPaneShell,
    mobiusSessionMessageColumnClassName,
    mobiusSessionMessageItemClassName,
    mobiusSessionMessageScrollClassName,
} from "./mobius-session-pane.tsx";
import { PairingInstruction } from "./pairing-instruction.tsx";

const PREVIEW_SESSIONS = [
    { id: "preview-session-1", title: "Refactor sidebar spacing", directoryLabel: "~/morty" },
    { id: "preview-session-2", title: "Update chat composer styles", directoryLabel: "~/morty/packages/web" },
] as const;

function PreviewConnectionStatus({ status }: { readonly status: BotConnectionStatus }) {
    const dot =
        status.kind === "connected"
            ? "bg-primary"
            : status.kind === "connecting"
              ? "animate-pulse bg-amber-500 motion-reduce:animate-none"
              : "bg-muted-foreground/60";
    return (
        <div
            className="flex min-h-10 items-center justify-self-end gap-2 px-1.5 py-1.5 sm:mb-6 sm:min-h-0 sm:self-start"
            data-testid={dataTestId.botConnectionStatus}
            data-connection-status={status.kind}
        >
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
            <span className="hidden min-w-0 flex-1 truncate text-xs font-medium text-foreground sm:block">
                {status.label}
            </span>
            <span className="sr-only sm:hidden">Agent {status.label.toLowerCase()}</span>
        </div>
    );
}

function PreviewSidebarAction({ children, label }: { readonly children: ReactNode; readonly label: string }) {
    return (
        <Tooltip.Root>
            <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
            <Tooltip.Portal>
                <MortyTooltipContent side="bottom" sideOffset={6}>
                    {label}
                    <Tooltip.Arrow className="fill-foreground" />
                </MortyTooltipContent>
            </Tooltip.Portal>
        </Tooltip.Root>
    );
}

function PreviewSidebar({
    activeId,
    connectionStatus,
    variant,
}: {
    readonly activeId: string;
    readonly connectionStatus: BotConnectionStatus;
    readonly variant: "empty-setup" | "sessions";
}) {
    return (
        <aside
            aria-label="Morty navigation"
            className="grid min-h-0 w-full shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-y-2 overflow-hidden border-b border-border/80 bg-sidebar px-3 py-3 sm:flex sm:w-[280px] sm:flex-col sm:gap-0 sm:border-r sm:border-b-0 sm:px-3.5 sm:py-4"
        >
            <div className="col-start-1 row-start-1 flex items-center gap-3 px-1.5 sm:col-auto sm:row-auto sm:mb-3">
                <span
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-[0_4px_12px_rgba(47,184,114,0.18)]"
                >
                    M
                </span>
                <span className="hidden min-w-0 sm:block">
                    <h1 className="truncate text-[15px] leading-5 font-semibold tracking-[-0.015em]">Morty</h1>
                </span>
            </div>
            <PreviewConnectionStatus status={connectionStatus} />
            <div className="col-start-1 row-start-2 flex min-w-0 items-center justify-between px-1 sm:col-auto sm:row-auto sm:mb-2">
                <h2 className="hidden text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:block">
                    Recent sessions
                </h2>
                <Button
                    variant="ghost"
                    className="size-10 shrink-0 justify-center rounded-lg px-0 sm:hidden"
                    aria-label="Recent sessions"
                    type="button"
                >
                    <List aria-hidden="true" className="size-5" />
                </Button>
                <Tooltip.Provider delayDuration={150}>
                    <div className="flex items-center gap-0.5">
                        <PreviewSidebarAction label="New Session">
                            <Button aria-label="New Session" className="size-8 rounded-lg" size="icon" variant="ghost">
                                <SquarePen aria-hidden="true" className="size-3.5" />
                            </Button>
                        </PreviewSidebarAction>
                        <PreviewSidebarAction label="Open Session">
                            <Button aria-label="Open Session" className="size-8 rounded-lg" size="icon" variant="ghost">
                                <Laptop aria-hidden="true" className="size-3.5" />
                            </Button>
                        </PreviewSidebarAction>
                        <PreviewSidebarAction label="Refresh sessions">
                            <Button
                                aria-label="Refresh sessions"
                                className="size-8 rounded-lg"
                                size="icon"
                                variant="ghost"
                            >
                                <RefreshCw aria-hidden="true" className="size-3.5" />
                            </Button>
                        </PreviewSidebarAction>
                    </div>
                </Tooltip.Provider>
            </div>
            <div
                id="chat-conversations"
                className="col-span-2 row-start-3 max-h-48 min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5 sm:col-auto sm:row-auto sm:block sm:max-h-none"
            >
                {variant === "empty-setup" ? (
                    <div
                        className="mx-1 flex flex-col items-center rounded-xl border border-border/70 bg-white/55 px-4 py-5 text-center shadow-[0_1px_3px_rgba(17,24,20,0.04)]"
                        data-testid={dataTestId.conversationSetupRequired}
                    >
                        <span className="mb-2 flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary">
                            <MessageSquare aria-hidden="true" className="size-4" />
                        </span>
                        <p className="text-sm font-medium text-foreground">No sessions yet</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            Connect your local agent to start chatting.
                        </p>
                        <Button className="mt-3" size="sm" type="button" variant="outline">
                            Connect agent
                        </Button>
                    </div>
                ) : (
                    <section className="space-y-1">
                        <h3 className="px-[12px] pt-2 pb-1 text-[11px] font-semibold text-muted-foreground">Today</h3>
                        {PREVIEW_SESSIONS.map((session) => (
                            <button
                                key={session.id}
                                data-testid={dataTestId.managedConversation}
                                type="button"
                                aria-current={activeId === session.id ? "page" : undefined}
                                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-[12px] py-2.5 text-left text-[13px] font-medium text-copy-secondary outline-none transition-[background-color,color] duration-150 hover:bg-white/70 focus-visible:ring-2 focus-visible:ring-ring/60 aria-[current=page]:bg-white aria-[current=page]:text-foreground motion-reduce:transition-none"
                            >
                                <span className="min-w-0">
                                    <span className="block truncate">{session.title}</span>
                                    <span className="block truncate text-[11px] leading-4 font-normal text-copy-secondary">
                                        {session.directoryLabel}
                                    </span>
                                </span>
                            </button>
                        ))}
                    </section>
                )}
            </div>
            <div className="col-span-2 row-start-4 mt-auto hidden shrink-0 items-center justify-between gap-1 border-t border-border/70 pt-3 sm:col-auto sm:row-auto sm:flex">
                <Button aria-label="Theme" className="size-9 rounded-lg" size="icon" type="button" variant="ghost">
                    <Wifi aria-hidden="true" className="size-4" />
                </Button>
                <Button aria-label="Account" className="size-9 rounded-lg" size="icon" type="button" variant="ghost">
                    <UserRound aria-hidden="true" className="size-4" />
                </Button>
                <Button
                    aria-label="Share Morty"
                    className="size-9 rounded-lg"
                    size="icon"
                    type="button"
                    variant="ghost"
                >
                    <Share2 aria-hidden="true" className="size-4" />
                </Button>
            </div>
        </aside>
    );
}

function PreviewLanding({ connecting }: { readonly connecting: boolean }) {
    return (
        <div className="m-auto w-full max-w-lg px-6 text-center" data-testid={dataTestId.chatLanding}>
            <div className="mx-auto w-fit [&>div]:mb-5">
                <SetupCardLogo />
            </div>
            <p className="mb-2 text-13 font-medium tracking-[0.06em] text-primary uppercase">
                {connecting ? "Connecting to agent" : "Ready to collaborate"}
            </p>
            <h1 className="text-32 font-semibold tracking-[-0.035em]">Morty</h1>
            <p className="mx-auto mt-3 max-w-sm text-16 leading-[26px] text-muted-foreground">
                {connecting
                    ? "Chat is restoring access to this session."
                    : "Ask a question, explore your project, or start a task with your local agent."}
            </p>
        </div>
    );
}

function PreviewComposerControls() {
    return (
        <div
            aria-hidden="true"
            className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border/60 pt-2 text-[13px] text-muted-foreground"
        >
            <span className="rounded-lg border border-border bg-background px-2.5 py-1.5">Agent · Codex</span>
            <span className="rounded-lg border border-border bg-background px-2.5 py-1.5">~/morty</span>
        </div>
    );
}

function PreviewComposer({ draftSeed = "" }: { readonly draftSeed?: string }) {
    const [draft, setDraft] = useState(draftSeed);
    const [attachmentStore] = useState(() => createComposerAttachmentStore());
    const [attachmentSignal] = useState(() => new AbortController().signal);
    const attachmentModel = useStore(attachmentStore);
    return (
        <BotChatComposer
            attachmentModel={attachmentModel}
            attachmentSignal={attachmentSignal}
            disabled={false}
            draft={draft}
            error=""
            onDraftChange={setDraft}
            onStop={() => {}}
            onSubmit={() => {}}
            outputState="idle"
            submitDisabled={draft.trim().length === 0 && attachmentModel.attachments.length === 0}
        >
            <PreviewComposerControls />
        </BotChatComposer>
    );
}

function ChatPreviewShell({
    activeId,
    connectionStatus,
    sidebarVariant,
    children,
    composer,
    sessionTitle = "Untitled session",
}: {
    readonly activeId: string;
    readonly connectionStatus: BotConnectionStatus;
    readonly sidebarVariant: "empty-setup" | "sessions";
    readonly children: ReactNode;
    readonly composer?: ReactNode;
    readonly sessionTitle?: string;
}) {
    const messageList = useRef<HTMLDivElement>(null);
    return (
        <main
            aria-label="Chat preview"
            className="fixed inset-0 flex min-h-0 overflow-hidden bg-sidebar text-foreground max-sm:flex-col sm:flex-row"
        >
            <PreviewSidebar activeId={activeId} connectionStatus={connectionStatus} variant={sidebarVariant} />
            <MobiusSessionPaneShell footer={composer} title={sessionTitle}>
                <FollowLatestScrollArea
                    aria-label="Messages"
                    className={mobiusSessionMessageScrollClassName}
                    container={messageList}
                    followRevision={null}
                    followThreshold={80}
                    role="log"
                    showTopFade
                >
                    <div className={`${mobiusSessionMessageColumnClassName} flex min-h-full flex-col`}>{children}</div>
                </FollowLatestScrollArea>
            </MobiusSessionPaneShell>
        </main>
    );
}

export function ChatPreviewPageContent({ previewId }: { readonly previewId: ChatPreviewStateId }) {
    switch (previewId) {
        case "interactive":
            return <InteractiveChatPreview />;
        case "landing-disconnected":
            return (
                <ChatPreviewShell
                    activeId=""
                    connectionStatus={{ kind: "unpaired", label: "Disconnected" }}
                    sidebarVariant="empty-setup"
                >
                    <PreviewLanding connecting={false} />
                </ChatPreviewShell>
            );
        case "landing-composer":
            return (
                <ChatPreviewShell
                    activeId=""
                    composer={<PreviewComposer draftSeed="Tune the composer padding and send button…" />}
                    connectionStatus={{ kind: "connected", label: "Connected" }}
                    sidebarVariant="sessions"
                >
                    <PreviewLanding connecting={false} />
                </ChatPreviewShell>
            );
        case "conversation":
            return (
                <ChatPreviewShell
                    activeId={PREVIEW_SESSIONS[0].id}
                    composer={<PreviewComposer />}
                    connectionStatus={{ kind: "connected", label: "Connected" }}
                    sessionTitle={PREVIEW_SESSIONS[0].title}
                    sidebarVariant="sessions"
                >
                    <div className={mobiusSessionMessageItemClassName}>
                        <UserPromptMessage
                            images={[]}
                            resources={[]}
                            text="Help me tighten spacing on the chat sidebar and message bubbles."
                        />
                    </div>
                    <div className={mobiusSessionMessageItemClassName}>
                        <MobiusAssistantText
                            openLocalFile={() => {}}
                            streaming={false}
                            text="Start with `conversation-sidebar.tsx` for the session list and `user-prompt-message.tsx` for bubble radii. Save and check `/chat/preview/conversation` for updates."
                        />
                    </div>
                </ChatPreviewShell>
            );
        case "setup-card":
            return (
                <SetupCardShell titleId="chat-preview-setup-title">
                    <SetupCardTitle id="chat-preview-setup-title">Connect your local agent</SetupCardTitle>
                    <SetupCardDescription>
                        Copy this instruction into your agent. It will connect itself and finish the setup for you.
                    </SetupCardDescription>
                    <PairingInstruction />
                </SetupCardShell>
            );
        case "pairing-dialog":
            return (
                <>
                    <ChatPreviewShell
                        activeId=""
                        connectionStatus={{ kind: "unpaired", label: "Disconnected" }}
                        sidebarVariant="empty-setup"
                    >
                        <PreviewLanding connecting={false} />
                    </ChatPreviewShell>
                    <Dialog
                        appearance="setup"
                        description="Copy this instruction into your agent. It will connect itself and finish the setup for you."
                        onClose={() => {}}
                        title="Connect your local agent"
                    >
                        <PairingInstruction />
                    </Dialog>
                </>
            );
    }
}
