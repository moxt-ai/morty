import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { createNativeSessionStore } from "../../view-models/chat/native-session-store.ts";
import { MobiusSessionMessage } from "./mobius-session-message.tsx";

export type { OpenMobiusSession } from "../../view-models/chat/open-session.ts";

const loadMoreNativeSessions = "load-more-native-sessions";

function NativeSessionDirectorySkeleton() {
    return (
        <div role="status" aria-label="Discovering native sessions">
            <span className="sr-only">Discovering native sessions</span>
            <div aria-hidden="true" className="grid animate-pulse gap-2 motion-reduce:animate-none">
                <div className="rounded-lg p-3">
                    <div className="h-4 w-3/4 rounded-full bg-muted" />
                    <div className="mt-2 h-3 w-1/2 rounded-full bg-muted" />
                </div>
                <div className="rounded-lg p-3">
                    <div className="h-4 w-2/3 rounded-full bg-muted" />
                    <div className="mt-2 h-3 w-3/5 rounded-full bg-muted" />
                </div>
                <div className="rounded-lg p-3">
                    <div className="h-4 w-4/5 rounded-full bg-muted" />
                    <div className="mt-2 h-3 w-2/5 rounded-full bg-muted" />
                </div>
            </div>
        </div>
    );
}

function NativeSessionPreviewSkeleton() {
    return (
        <div role="status" aria-label="Loading session preview">
            <div aria-hidden="true" className="grid animate-pulse gap-8 motion-reduce:animate-none">
                <div className="h-5 w-2/5 rounded-full bg-muted" />
                <div className="ml-auto grid w-full max-w-[68%] justify-items-end gap-2">
                    <div className="h-4 w-2/3 rounded-full bg-muted" />
                    <div className="h-4 w-full rounded-full bg-muted" />
                    <div className="h-4 w-4/5 rounded-full bg-muted" />
                </div>
                <div className="grid w-full max-w-[78%] gap-2">
                    <div className="h-4 w-1/3 rounded-full bg-muted" />
                    <div className="h-4 w-full rounded-full bg-muted" />
                    <div className="h-4 w-5/6 rounded-full bg-muted" />
                    <div className="h-4 w-3/5 rounded-full bg-muted" />
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
    readonly store: ReturnType<typeof createNativeSessionStore>;
    readonly onClose: () => void;
}) {
    const model = useStore(store);
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
            description="Select a local agent session to preview it, then open it or fork it as a Mobius Session."
            onClose={closeDialog}
            busy={model.operation === "import" || model.operation === "fork"}
            wide
        >
            <div className="grid h-[min(60dvh,36rem)] min-h-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-border sm:grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)] sm:grid-rows-1">
                <section
                    aria-label="Native sessions"
                    className="flex min-h-0 flex-col gap-3 border-b border-border bg-muted/30 p-3 sm:border-r sm:border-b-0"
                >
                    <h2 className="font-semibold">Native Session</h2>
                    {model.agents.length > 0 && (
                        <Select
                            label="Session agent"
                            value={
                                model.selected ||
                                (fallback === undefined ? "" : `${fallback.runtimeId}:${fallback.agentRef}`)
                            }
                            disabled={model.operation !== "idle"}
                            options={model.agents.map((agent) => ({
                                value: `${agent.runtimeId}:${agent.agentRef}`,
                                label: agent.label,
                            }))}
                            onValueChange={store.getState().selectAgent}
                        />
                    )}
                    {model.directory.kind === "loading" && <NativeSessionDirectorySkeleton />}
                    {model.directory.kind === "empty" && <p>Connect a local agent to browse its sessions.</p>}
                    {model.directory.kind === "failed" && <p role="alert">{model.directory.message}</p>}
                    {model.directory.kind === "ready" && model.directory.entries.length === 0 && (
                        <p>No saved sessions were reported by this agent.</p>
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
                                            ? model.directory.entries.find((candidate) => candidate.entryId === entryId)
                                            : undefined;
                                    if (entry !== undefined) {
                                        withSignal(async (signal) => await store.getState().select(entry, signal));
                                    }
                                }}
                            />
                        </div>
                    )}
                    {model.directory.kind === "ready" && model.directory.entries.length > 0 && (
                        <div className="hidden min-h-0 flex-1 space-y-1 overflow-y-auto sm:block">
                            {model.directory.entries.map((entry) => (
                                <button
                                    type="button"
                                    key={entry.entryId}
                                    data-testid={dataTestId.localSessionEntry}
                                    aria-label={entry.title || "Untitled session"}
                                    aria-pressed={
                                        model.preview.kind !== "empty" && model.preview.entry.entryId === entry.entryId
                                    }
                                    disabled={model.operation !== "idle"}
                                    onClick={() =>
                                        withSignal(async (signal) => await store.getState().select(entry, signal))
                                    }
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
                        </div>
                    )}
                    {model.directory.kind === "ready" && model.directory.nextCursor !== null && (
                        <div className="hidden sm:block">
                            <Button
                                variant="ghost"
                                disabled={model.operation !== "idle"}
                                onClick={() => withSignal(store.getState().more)}
                            >
                                Load more
                            </Button>
                        </div>
                    )}
                </section>
                <section
                    aria-label="Selected session preview"
                    className={`min-w-0 overflow-y-auto p-4 sm:p-6 ${model.preview.kind === "empty" ? "flex items-center justify-center" : ""}`}
                >
                    {model.preview.kind === "empty" && (
                        <p className="text-center text-muted-foreground">Select a session to preview its history.</p>
                    )}
                    {model.preview.kind === "loading" && <NativeSessionPreviewSkeleton />}
                    {model.preview.kind === "failed" && (
                        <p role="alert" className="text-destructive">
                            {model.preview.message}
                        </p>
                    )}
                    {model.preview.kind === "ready" && (
                        <div className="space-y-4">
                            <h2 className="font-semibold">{model.preview.entry.title || "Untitled session"}</h2>
                            {model.preview.content.messages.length === 0 && <p>No events in this session.</p>}
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
                                <p className="text-muted-foreground">Showing a partial event preview.</p>
                            )}
                        </div>
                    )}
                </section>
            </div>
            <footer className="mt-5 flex justify-end gap-2">
                <Button
                    variant="outline"
                    disabled={model.operation === "import" || model.operation === "fork"}
                    onClick={closeDialog}
                >
                    Cancel
                </Button>
                <Button
                    data-testid={dataTestId.importLocalSession}
                    variant="outline"
                    disabled={
                        model.preview.kind !== "ready" ||
                        model.operation !== "idle" ||
                        model.directory.kind !== "ready" ||
                        (!model.directory.capabilities.loadSession && !model.directory.capabilities.resumeSession)
                    }
                    onClick={() => withSignal(async (signal) => await store.getState().open("import", signal))}
                >
                    {model.operation === "import" ? "Opening…" : "Open"}
                </Button>
                <Button
                    data-testid={dataTestId.forkLocalSession}
                    disabled={model.preview.kind !== "ready" || model.operation !== "idle"}
                    onClick={() => withSignal(async (signal) => await store.getState().open("fork", signal))}
                >
                    {model.operation === "fork" ? "Forking…" : "Fork"}
                </Button>
            </footer>
            {model.error !== "" &&
                createPortal(
                    <div
                        className="fixed right-4 bottom-4 z-[70] max-w-sm rounded-xl border border-destructive/20 bg-white px-4 py-3 text-sm text-destructive shadow-lg"
                        role="alert"
                    >
                        {model.error}
                    </div>,
                    document.body,
                )}
        </Dialog>
    );
}
