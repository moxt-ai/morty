import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { sentryBugReportSink } from "../../services/diagnostics/bug-report.ts";
import { createBugReportStore } from "../../view-models/bug-report-store.ts";

export function BugReportButton({ floating = false }: { readonly floating?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                variant="ghost"
                className={
                    floating ? "fixed bottom-2 right-2 z-40 bg-background/90 text-xs" : "min-h-10 shrink-0 text-xs"
                }
                onClick={() => setOpen(true)}
            >
                Report a bug
            </Button>
            {open && <BugReportDialog onClose={() => setOpen(false)} />}
        </>
    );
}
function BugReportDialog({ onClose }: { readonly onClose: () => void }) {
    const [store] = useState(() => createBugReportStore(sentryBugReportSink));
    const { state, description, describe, send, close } = useStore(store);
    useEffect(() => close, [close]);
    return (
        <Dialog
            title="Report a bug"
            description="Send a description and recent technical diagnostics. Conversation text, files and credentials are not collected. Your description is shared with the Morty team."
            onClose={onClose}
        >
            {state.kind === "sent" ? (
                <div role="status" className="break-all">
                    <p>Report sent. Reference: {state.id}</p>
                    {!state.daemonAvailable && (
                        <p>Daemon diagnostics were unavailable; Web diagnostics were included.</p>
                    )}
                    {state.truncated && <p>Older diagnostics were omitted to keep this report small.</p>}
                </div>
            ) : (
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void send();
                    }}
                    className="space-y-3"
                >
                    <label className="block" htmlFor="bug-description">
                        What went wrong?
                    </label>
                    <textarea
                        id="bug-description"
                        className="min-h-28 w-full rounded-md border border-border bg-background p-2"
                        maxLength={2000}
                        required
                        disabled={state.kind === "sending"}
                        value={description}
                        onChange={(event) => describe(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                        Daemon diagnostics may take up to 10 seconds. You can still send a report when your machine is
                        offline.
                    </p>
                    {state.kind === "failed" && <p role="alert">{state.message}</p>}
                    {state.kind === "sending" && <p role="status">Collecting diagnostics and sending…</p>}
                    <Button type="submit" disabled={state.kind === "sending" || description.trim() === ""}>
                        Send report
                    </Button>
                </form>
            )}
        </Dialog>
    );
}
