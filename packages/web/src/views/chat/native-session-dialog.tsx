import { CircleAlert, Inbox, MessageSquare, PackageOpen, Unplug } from "lucide-react";
import type { ReactNode } from "react";
import type { StoreApi } from "zustand/vanilla";
import { mortyThinScrollbarClassName } from "../../components/chat/chat-session-layout.ts";
import { NativeSessionDirectoryPlaceholder } from "../../components/chat/native-session-directory-placeholder.tsx";
import { SessionAgentTabs } from "../../components/chat/session-agent-tabs.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { ScrollEdgeFade } from "../../components/utils/scroll-edge-fade.tsx";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import type { DaemonDiagnosticsSource } from "../../services/diagnostics/browser-diagnostics.ts";
import type { BugReportDialogStore } from "../../view-models/bug-report-dialog-store.ts";
import type { NativeSessionAgent } from "../../view-models/chat/native-session-agents.ts";
import type { NativeSessionStore } from "../../view-models/chat/native-session-store.ts";
import { useExternalStore } from "../../view-models/external-store.ts";
import { BugReportButton } from "../diagnostics/bug-report-button.tsx";
import { MobiusSessionMessage } from "./mobius-session-message.tsx";

const loadMoreNativeSessions = "load-more-native-sessions";

const nativeSessionPreviewTitleBarClassName =
    "flex h-9 min-w-0 shrink-0 items-center px-4 font-inter text-14 font-semibold tracking-[-0.015em] sm:mt-[11px] sm:pr-[59px] sm:pl-6";

function NativeSessionDirectoryDiscovering() {
    return (
        <div role="status" aria-label="Discovering native sessions" className="min-h-0 flex-1">
            <span className="sr-only">Discovering native sessions</span>
            <NativeSessionDirectoryListSkeleton />
        </div>
    );
}

function NativeSessionDirectoryListSkeleton() {
    return (
        <div aria-hidden="true" className="grid animate-pulse motion-reduce:animate-none">
            <div className="rounded-[20px] px-2.5 py-2">
                <div className="h-3.5 w-3/4 rounded-full bg-morty-fill-opacity-3" />
            </div>
            <div className="rounded-[20px] px-2.5 py-2">
                <div className="h-3.5 w-2/3 rounded-full bg-morty-fill-opacity-3" />
            </div>
            <div className="rounded-[20px] px-2.5 py-2">
                <div className="h-3.5 w-4/5 rounded-full bg-morty-fill-opacity-3" />
            </div>
        </div>
    );
}

function NativeSessionAgentTabsSkeleton() {
    return (
        <div
            aria-hidden="true"
            className="mx-2.5 flex h-9 animate-pulse gap-0.5 rounded-full bg-morty-fill-opacity-2 p-0.5 motion-reduce:animate-none"
        >
            <div className="h-full w-10 rounded-full bg-morty-fill-opacity-3" />
            <div className="h-full w-10 rounded-full bg-morty-fill-opacity-3" />
            <div className="h-full w-10 rounded-full bg-morty-fill-opacity-3" />
        </div>
    );
}

function NativeSessionFooterSkeleton() {
    return (
        <div aria-hidden="true" className="flex animate-pulse justify-end gap-2 motion-reduce:animate-none">
            <div className="h-9 w-[4.5rem] rounded-full bg-morty-fill-opacity-3" />
            <div className="h-9 w-[4.5rem] rounded-full bg-morty-fill-opacity-3" />
        </div>
    );
}

function NativeSessionDialogDiscoveringSkeleton({ title }: { readonly title: ReactNode }) {
    return (
        <div role="status" aria-label="Discovering native sessions" className="contents">
            <span className="sr-only">Discovering native sessions</span>
            <div className="grid grid-cols-1 gap-0 sm:h-[min(72dvh,40rem)] sm:grid-cols-[minmax(15rem,16.5rem)_minmax(0,1fr)]">
                <div className="flex min-h-0 flex-col gap-1 px-4">
                    {title}
                    <section aria-label="Native sessions" className="-mx-2.5 flex min-h-0 flex-1 flex-col gap-2">
                        <NativeSessionAgentTabsSkeleton />
                        <NativeSessionDirectoryListSkeleton />
                    </section>
                </div>
                <div className="flex min-h-[18rem] min-w-0 flex-col overflow-hidden rounded-[22px] border border-white bg-card shadow-module sm:min-h-0">
                    <section
                        aria-label="Selected session preview"
                        className="flex min-h-0 min-w-0 flex-1 flex-col"
                        aria-busy="true"
                    >
                        <div aria-hidden="true" className={nativeSessionPreviewTitleBarClassName}>
                            <div className="h-3.5 w-2/5 max-w-full animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none" />
                        </div>
                        <div className="min-h-0 flex-1 p-4 sm:px-6 sm:py-5">
                            <NativeSessionPreviewSkeletonContent />
                        </div>
                    </section>
                    <footer className="flex shrink-0 px-4 py-3 sm:px-5">
                        <NativeSessionFooterSkeleton />
                    </footer>
                </div>
            </div>
        </div>
    );
}

function NativeSessionPreviewSkeletonContent() {
    return (
        <div aria-hidden="true" className="grid animate-pulse gap-8 motion-reduce:animate-none">
            <div className="h-5 w-2/5 rounded-full bg-morty-fill-opacity-3" />
            <div className="ml-auto grid w-full max-w-[68%] justify-items-end gap-2">
                <div className="h-4 w-2/3 rounded-full bg-morty-fill-opacity-3" />
                <div className="h-4 w-full rounded-full bg-morty-fill-opacity-2" />
                <div className="h-4 w-4/5 rounded-full bg-morty-fill-opacity-3" />
            </div>
            <div className="grid w-full max-w-[78%] gap-2">
                <div className="h-4 w-1/3 rounded-full bg-morty-fill-opacity-3" />
                <div className="h-4 w-full rounded-full bg-morty-fill-opacity-2" />
                <div className="h-4 w-5/6 rounded-full bg-morty-fill-opacity-3" />
                <div className="h-4 w-3/5 rounded-full bg-morty-fill-opacity-2" />
            </div>
        </div>
    );
}

function NativeSessionPreviewSkeleton() {
    return (
        <div role="status" aria-label="Loading session preview">
            <span className="sr-only">Loading session preview</span>
            <NativeSessionPreviewSkeletonContent />
        </div>
    );
}

export function NativeSessionDialog({
    store,
    agents,
    onClose,
    bugReportDialog,
    daemonSource,
}: {
    /** Created by the owner when the dialog opens; it starts discovery itself. */
    readonly store: StoreApi<NativeSessionStore>;
    /** The agent tabs, as the Runtime configuration the page follows offers them. */
    readonly agents: readonly NativeSessionAgent[];
    readonly onClose: () => void;
    readonly bugReportDialog: BugReportDialogStore;
    readonly daemonSource: DaemonDiagnosticsSource;
}) {
    const model = useExternalStore(store);
    const diagnostics: DaemonDiagnosticsSource = {
        ...daemonSource,
        sessionId: null,
        nativeSessionId: model.preview.kind === "empty" ? null : model.preview.entry.nativeSessionId,
    };
    const reportButton = <BugReportButton appearance="icon" daemonSource={diagnostics} dialog={bugReportDialog} />;
    const withSignal = (action: (signal: AbortSignal) => Promise<void>) => {
        void action(store.getState().lifetimeSignal());
    };
    const fallback = agents[0];
    const selectedEntryId = model.preview.kind === "empty" ? "" : model.preview.entry.entryId;
    const closeDialog = () => {
        store.getState().stop();
        onClose();
    };
    return (
        <Dialog
            title="Open Session"
            onClose={closeDialog}
            busy={model.operation === "import" || model.operation === "fork"}
            appearance="surface"
            wide
        >
            {(title) => (
                <>
                    {model.directory.kind === "loading" && model.directory.scope === "initial" ? (
                        <NativeSessionDialogDiscoveringSkeleton title={title} />
                    ) : (
                        <div className="grid grid-cols-1 gap-0 sm:h-[min(72dvh,40rem)] sm:grid-cols-[minmax(15rem,16.5rem)_minmax(0,1fr)]">
                            <div className="flex min-h-0 flex-col gap-1 px-4">
                                {title}
                                <section
                                    aria-label="Native sessions"
                                    className="-mx-2.5 flex min-h-0 flex-1 flex-col gap-2"
                                >
                                    {agents.length > 0 && (
                                        <SessionAgentTabs
                                            agents={agents}
                                            className="mx-2.5"
                                            dimInactive={
                                                !(
                                                    model.directory.kind === "loading" &&
                                                    model.directory.scope === "refresh"
                                                )
                                            }
                                            disabled={model.operation !== "idle"}
                                            onValueChange={store.getState().selectAgent}
                                            value={
                                                model.selected ||
                                                (fallback === undefined
                                                    ? ""
                                                    : `${fallback.runtimeId}:${fallback.agentRef}`)
                                            }
                                        />
                                    )}
                                    {model.directory.kind === "loading" && model.directory.scope === "refresh" && (
                                        <NativeSessionDirectoryDiscovering />
                                    )}
                                    {model.directory.kind === "empty" && (
                                        <NativeSessionDirectoryPlaceholder
                                            icon={Unplug}
                                            title="No local agent"
                                            description="Connect a runtime to browse saved sessions."
                                        />
                                    )}
                                    {model.directory.kind === "agent-unavailable" && (
                                        <NativeSessionDirectoryPlaceholder
                                            icon={PackageOpen}
                                            title={`${model.directory.agentLabel} is not installed`}
                                            description="Install it on this machine to browse saved sessions."
                                        />
                                    )}
                                    {model.directory.kind === "failed" && (
                                        <NativeSessionDirectoryPlaceholder
                                            icon={CircleAlert}
                                            title="Couldn't load sessions"
                                            description={
                                                <span className="inline-flex items-start gap-2 text-left">
                                                    <span className="min-w-0 break-words">
                                                        {model.directory.message}
                                                    </span>
                                                    {reportButton}
                                                </span>
                                            }
                                            tone="destructive"
                                        />
                                    )}
                                    {model.directory.kind === "ready" && model.directory.entries.length === 0 && (
                                        <NativeSessionDirectoryPlaceholder
                                            icon={Inbox}
                                            title="No saved sessions"
                                            description="This agent didn't report any on this machine."
                                        />
                                    )}
                                    {model.directory.kind === "ready" && model.directory.entries.length > 0 && (
                                        <div className="sm:hidden">
                                            <Select
                                                label="Native session"
                                                value={selectedEntryId}
                                                disabled={model.operation !== "idle"}
                                                truncateOptions
                                                options={[
                                                    ...model.directory.entries.map((entry) => ({
                                                        value: entry.entryId,
                                                        label: `${entry.title || "Untitled session"} · ${entry.directoryLabel}`,
                                                    })),
                                                    ...(model.directory.nextCursor === null
                                                        ? []
                                                        : [{ value: loadMoreNativeSessions, label: "Load more" }]),
                                                ]}
                                                onValueChange={(entryId) => {
                                                    if (entryId === loadMoreNativeSessions) {
                                                        withSignal(store.getState().more);
                                                        return;
                                                    }
                                                    const entry =
                                                        model.directory.kind === "ready"
                                                            ? model.directory.entries.find(
                                                                  (candidate) => candidate.entryId === entryId,
                                                              )
                                                            : undefined;
                                                    if (entry !== undefined) {
                                                        withSignal(
                                                            async (signal) =>
                                                                await store.getState().select(entry, signal),
                                                        );
                                                    }
                                                }}
                                            />
                                        </div>
                                    )}
                                    {model.directory.kind === "ready" && model.directory.entries.length > 0 && (
                                        <ScrollEdgeFade
                                            revealSurface
                                            edgeStroke={{
                                                className: "border-surface-dialog-composite",
                                                placement: "outside",
                                            }}
                                            frameClassName="hidden min-h-0 flex-1 sm:flex sm:flex-col"
                                            className={cn(
                                                "min-h-0 flex-1 space-y-0 overflow-y-auto pr-3 pb-2 pl-1",
                                                mortyThinScrollbarClassName,
                                            )}
                                        >
                                            {model.directory.entries.map((entry) => (
                                                <button
                                                    type="button"
                                                    key={entry.entryId}
                                                    data-testid={dataTestId.localSessionEntry}
                                                    aria-label={entry.title || "Untitled session"}
                                                    aria-pressed={
                                                        model.preview.kind !== "empty" &&
                                                        model.preview.entry.entryId === entry.entryId
                                                    }
                                                    disabled={model.operation !== "idle"}
                                                    onClick={() =>
                                                        withSignal(
                                                            async (signal) =>
                                                                await store.getState().select(entry, signal),
                                                        )
                                                    }
                                                    className="box-border mb-0 grid h-9 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-[20px] px-2.5 text-left text-[13px] font-medium text-copy-secondary outline-none transition-[background-color,color] duration-150 hover:bg-morty-fill-opacity-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:text-copy-secondary disabled:hover:bg-transparent disabled:hover:text-copy-secondary aria-pressed:bg-morty-fill-opacity-3 aria-pressed:text-foreground aria-pressed:hover:bg-morty-fill-opacity-4 aria-pressed:hover:text-foreground aria-pressed:disabled:hover:text-foreground disabled:aria-pressed:text-foreground motion-reduce:transition-none"
                                                >
                                                    <span className="min-w-0 truncate">
                                                        {entry.title || "Untitled session"}
                                                    </span>
                                                </button>
                                            ))}
                                            {model.directory.nextCursor !== null && (
                                                <div className="flex justify-center py-2">
                                                    {model.operation === "more" ? (
                                                        <Spinner label="Loading more sessions" />
                                                    ) : (
                                                        <Button
                                                            variant="ghost"
                                                            disabled={model.operation !== "idle"}
                                                            onClick={() => withSignal(store.getState().more)}
                                                        >
                                                            Load more
                                                        </Button>
                                                    )}
                                                </div>
                                            )}
                                        </ScrollEdgeFade>
                                    )}
                                </section>
                            </div>
                            <div className="flex min-h-[18rem] min-w-0 flex-col overflow-hidden rounded-[22px] border border-white bg-card shadow-module sm:min-h-0">
                                <section
                                    aria-label="Selected session preview"
                                    className="flex min-h-0 min-w-0 flex-1 flex-col"
                                >
                                    {model.preview.kind === "ready" && (
                                        <h2
                                            className={nativeSessionPreviewTitleBarClassName}
                                            title={model.preview.entry.title || "Untitled session"}
                                        >
                                            <span className="min-w-0 truncate">
                                                {model.preview.entry.title || "Untitled session"}
                                            </span>
                                        </h2>
                                    )}
                                    {model.preview.kind === "loading" && (
                                        <div aria-hidden="true" className={nativeSessionPreviewTitleBarClassName}>
                                            <div className="h-3.5 w-2/5 max-w-full animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none" />
                                        </div>
                                    )}
                                    {model.preview.kind === "empty" && (
                                        <div aria-hidden="true" className={nativeSessionPreviewTitleBarClassName} />
                                    )}
                                    <ScrollEdgeFade
                                        revealSurface
                                        edgeStroke={{ className: "border-card", placement: "outside" }}
                                        frameClassName="flex min-h-0 flex-1 flex-col"
                                        className={cn(
                                            "min-h-0 flex-1 overflow-y-auto font-inter",
                                            model.preview.kind === "ready"
                                                ? "px-4 pt-4 pb-4 sm:px-6 sm:pt-4 sm:pb-5"
                                                : model.preview.kind === "empty"
                                                  ? undefined
                                                  : "p-4 sm:px-6 sm:py-5",
                                            mortyThinScrollbarClassName,
                                            model.preview.kind === "empty" && "flex min-h-0 flex-1 flex-col",
                                        )}
                                    >
                                        {model.preview.kind === "empty" && (
                                            <NativeSessionDirectoryPlaceholder
                                                icon={MessageSquare}
                                                title="Select a session"
                                                description="Preview its message history here."
                                            />
                                        )}
                                        {model.preview.kind === "loading" && <NativeSessionPreviewSkeleton />}
                                        {model.preview.kind === "failed" && (
                                            <div role="alert" className="flex items-start gap-2 text-destructive">
                                                <p className="min-w-0 flex-1 break-words">{model.preview.message}</p>
                                                {reportButton}
                                            </div>
                                        )}
                                        {model.preview.kind === "ready" && (
                                            <div className="space-y-4">
                                                {model.preview.content.messages.length === 0 && (
                                                    <p>No events in this session.</p>
                                                )}
                                                {model.preview.content.messages.map((message) => (
                                                    <MobiusSessionMessage
                                                        deliveryUnknownUserMessageId={null}
                                                        failureApproval={{ kind: "unavailable" }}
                                                        key={message.firstEvent.eventId}
                                                        message={message}
                                                        onRemoveUnknownDelivery={() => undefined}
                                                        onRetryUnknownDelivery={() => undefined}
                                                        openLocalFile={() => undefined}
                                                    />
                                                ))}
                                                {model.preview.content.truncated && (
                                                    <p className="text-13 text-morty-text-3">
                                                        Showing a partial event preview.
                                                    </p>
                                                )}
                                            </div>
                                        )}
                                    </ScrollEdgeFade>
                                </section>
                                {model.error !== "" && (
                                    <div
                                        className="mx-4 flex items-start gap-2 rounded-2xl border border-destructive/20 bg-card px-4 py-3 text-13 text-destructive sm:mx-5"
                                        role="alert"
                                    >
                                        <span className="min-w-0 flex-1 break-words">{model.error}</span>
                                        {reportButton}
                                    </div>
                                )}
                                <footer className="flex shrink-0 justify-end gap-2 px-4 py-3 sm:px-5">
                                    <Button
                                        data-testid={dataTestId.importLocalSession}
                                        variant="outline"
                                        disabled={
                                            model.preview.kind !== "ready" ||
                                            model.operation !== "idle" ||
                                            model.directory.kind !== "ready" ||
                                            (!model.directory.capabilities.loadSession &&
                                                !model.directory.capabilities.resumeSession)
                                        }
                                        onClick={() =>
                                            withSignal(async (signal) => await store.getState().open("import", signal))
                                        }
                                    >
                                        {model.operation === "import" ? "Opening…" : "Open"}
                                    </Button>
                                    <Button
                                        data-testid={dataTestId.forkLocalSession}
                                        disabled={model.preview.kind !== "ready" || model.operation !== "idle"}
                                        onClick={() =>
                                            withSignal(async (signal) => await store.getState().open("fork", signal))
                                        }
                                    >
                                        {model.operation === "fork" ? "Forking…" : "Fork"}
                                    </Button>
                                </footer>
                            </div>
                        </div>
                    )}
                </>
            )}
        </Dialog>
    );
}
