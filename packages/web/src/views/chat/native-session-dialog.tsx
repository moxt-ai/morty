import { Tabs } from "radix-ui";
import { createPortal } from "react-dom";
import type { StoreApi } from "zustand/vanilla";
import { mortyThinScrollbarClassName } from "../../components/chat/chat-session-layout.ts";
import { HarnessMark } from "../../components/chat/harness-mark.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { ScrollEdgeFade } from "../../components/utils/scroll-edge-fade.tsx";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import type { NativeSessionStore } from "../../view-models/chat/native-session-store.ts";
import { useExternalStore } from "../../view-models/external-store.ts";
import { MobiusSessionMessage } from "./mobius-session-message.tsx";

const loadMoreNativeSessions = "load-more-native-sessions";

function NativeSessionDirectorySkeleton() {
    return (
        <div role="status" aria-label="Discovering native sessions">
            <span className="sr-only">Discovering native sessions</span>
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
        </div>
    );
}

function SessionAgentTabs({
    agents,
    disabled,
    onValueChange,
    value,
}: {
    readonly agents: NativeSessionStore["agents"];
    readonly disabled: boolean;
    readonly onValueChange: (value: string) => void;
    readonly value: string;
}) {
    return (
        <Tabs.Root className="mx-2.5" onValueChange={onValueChange} value={value}>
            <Tabs.List
                aria-label="Session agent"
                className="flex h-9 min-w-0 gap-0.5 rounded-full bg-morty-fill-opacity-2 p-0.5"
            >
                {agents.map((agent) => {
                    const optionValue = `${agent.runtimeId}:${agent.agentRef}`;
                    return (
                        <Tabs.Trigger
                            className="group relative flex min-w-0 shrink-0 grow-0 items-center justify-center gap-1.5 rounded-full px-1.5 text-[13px] text-copy-secondary outline-none transition-[flex-grow,background-color,color,box-shadow] duration-200 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=active]:grow data-[state=active]:shrink data-[state=active]:bg-background data-[state=active]:px-2.5 data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-sm motion-reduce:transition-none"
                            disabled={disabled}
                            key={optionValue}
                            title={agent.label}
                            value={optionValue}
                        >
                            <HarnessMark
                                agentRef={agent.agentRef}
                                appearance="line"
                                label={agent.label}
                                testId={dataTestId.harnessMark}
                            />
                            <span className="min-w-0 truncate group-data-[state=inactive]:sr-only">{agent.label}</span>
                        </Tabs.Trigger>
                    );
                })}
            </Tabs.List>
        </Tabs.Root>
    );
}

function NativeSessionPreviewSkeleton() {
    return (
        <div role="status" aria-label="Loading session preview">
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
        </div>
    );
}

export function NativeSessionDialog({
    store,
    onClose,
}: {
    /** Created by the owner when the dialog opens; it starts discovery itself. */
    readonly store: StoreApi<NativeSessionStore>;
    readonly onClose: () => void;
}) {
    const model = useExternalStore(store);
    const withSignal = (action: (signal: AbortSignal) => Promise<void>) => {
        void action(store.getState().lifetimeSignal());
    };
    const fallback = model.agents[0];
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
                    <div className="grid grid-cols-1 gap-0 sm:h-[min(72dvh,40rem)] sm:grid-cols-[minmax(15rem,17.5rem)_minmax(0,1fr)]">
                        <div className="flex min-h-0 flex-col gap-4 px-4">
                            {title}
                            <section
                                aria-label="Native sessions"
                                className="-mx-2.5 flex min-h-0 flex-1 flex-col gap-2 overflow-hidden"
                            >
                                <h2 className="px-2.5 pt-1 font-inter text-13 font-semibold tracking-normal text-foreground">
                                    Native Session
                                </h2>
                                {model.agents.length > 0 && (
                                    <SessionAgentTabs
                                        agents={model.agents}
                                        disabled={model.operation !== "idle"}
                                        onValueChange={store.getState().selectAgent}
                                        value={
                                            model.selected ||
                                            (fallback === undefined ? "" : `${fallback.runtimeId}:${fallback.agentRef}`)
                                        }
                                    />
                                )}
                                {model.directory.kind === "loading" && <NativeSessionDirectorySkeleton />}
                                {model.directory.kind === "empty" && (
                                    <p className="px-2.5 text-13 text-morty-text-3">
                                        Connect a local agent to browse its sessions.
                                    </p>
                                )}
                                {model.directory.kind === "failed" && (
                                    <p className="px-2.5 text-13 text-destructive" role="alert">
                                        {model.directory.message}
                                    </p>
                                )}
                                {model.directory.kind === "ready" && model.directory.entries.length === 0 && (
                                    <p className="px-2.5 text-13 text-morty-text-3">
                                        No saved sessions were reported by this agent.
                                    </p>
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
                                                        async (signal) => await store.getState().select(entry, signal),
                                                    );
                                                }
                                            }}
                                        />
                                    </div>
                                )}
                                {model.directory.kind === "ready" && model.directory.entries.length > 0 && (
                                    <ScrollEdgeFade
                                        fadeFromClassName="from-card/90"
                                        frameClassName="hidden min-h-0 flex-1 sm:flex sm:flex-col"
                                        className={cn(
                                            "min-h-0 flex-1 space-y-0 overflow-y-auto pr-3",
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
                                                        async (signal) => await store.getState().select(entry, signal),
                                                    )
                                                }
                                                className="box-border mb-0 grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-[20px] px-2.5 py-2 text-left text-[13px] font-medium text-copy-secondary outline-none transition-[background-color,color] duration-150 hover:bg-morty-fill-opacity-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:text-copy-secondary disabled:hover:bg-transparent disabled:hover:text-copy-secondary aria-pressed:bg-morty-fill-opacity-3 aria-pressed:text-foreground aria-pressed:hover:bg-morty-fill-opacity-4 aria-pressed:hover:text-foreground aria-pressed:disabled:hover:text-foreground disabled:aria-pressed:text-foreground motion-reduce:transition-none"
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
                        <div className="flex min-h-[18rem] min-w-0 flex-col overflow-hidden rounded-[22px] border border-white bg-card sm:min-h-0">
                            <section
                                aria-label="Selected session preview"
                                className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                            >
                                <ScrollEdgeFade
                                    fadeFromClassName="from-card"
                                    frameClassName="min-h-0 flex-1"
                                    className={cn(
                                        "min-h-0 flex-1 overflow-y-auto p-4 font-inter sm:px-6 sm:py-5",
                                        mortyThinScrollbarClassName,
                                        model.preview.kind === "empty" && "flex items-center justify-center",
                                    )}
                                >
                                    {model.preview.kind === "empty" && (
                                        <p className="text-center text-13 text-morty-text-3">
                                            Select a session to preview its history.
                                        </p>
                                    )}
                                    {model.preview.kind === "loading" && <NativeSessionPreviewSkeleton />}
                                    {model.preview.kind === "failed" && (
                                        <p role="alert" className="text-destructive">
                                            {model.preview.message}
                                        </p>
                                    )}
                                    {model.preview.kind === "ready" && (
                                        <div className="space-y-4">
                                            <h2 className="font-inter text-16 font-semibold tracking-[-0.015em]">
                                                {model.preview.entry.title || "Untitled session"}
                                            </h2>
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
                                <Button
                                    variant="outline"
                                    disabled={model.operation === "import" || model.operation === "fork"}
                                    onClick={closeDialog}
                                >
                                    Cancel
                                </Button>
                            </footer>
                        </div>
                    </div>
                    {model.error !== "" &&
                        createPortal(
                            <div
                                className="fixed right-4 bottom-4 z-[70] max-w-sm rounded-2xl border border-destructive/20 bg-card px-4 py-3 text-13 text-destructive shadow-module"
                                role="alert"
                            >
                                {model.error}
                            </div>,
                            document.body,
                        )}
                </>
            )}
        </Dialog>
    );
}
