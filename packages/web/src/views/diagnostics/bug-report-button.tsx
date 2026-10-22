import { Bug, X } from "lucide-react";
import { Tooltip } from "radix-ui";
import { AttachCancelBoundary, HiddenFileInput } from "../../components/diagnostics/attach-controls.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { ObjectUrlImage } from "../../components/ui/object-url-image.tsx";
import type { DaemonDiagnosticsSource } from "../../services/diagnostics/browser-diagnostics.ts";
import type { BugReportDialogStore } from "../../view-models/bug-report-dialog-store.ts";
import {
    type BugReportImage,
    type BugReportStoreApi,
    bugReportImageAccept,
} from "../../view-models/bug-report-store.ts";
import { useExternalStore } from "../../view-models/external-store.ts";

const appearances = {
    floating: "fixed bottom-2 right-2 z-40 bg-background/90 text-xs",
    icon: "size-8! min-h-8! shrink-0 justify-center rounded-full px-0 text-copy-secondary hover:bg-morty-fill-opacity-2 active:bg-morty-fill-opacity-3",
    labelled: "min-h-10 shrink-0 text-xs",
};

export function BugReportButton({
    appearance = "labelled",
    daemonSource = null,
    dialog,
}: {
    readonly appearance?: keyof typeof appearances | "option";
    readonly daemonSource?: DaemonDiagnosticsSource | null;
    readonly dialog: BugReportDialogStore;
}) {
    const showBugReport = dialog.getState().show;
    const trigger =
        appearance === "option" ? (
            <button
                type="button"
                aria-label="Report a bug"
                className="flex w-full items-center gap-2.5 rounded-lg px-[10px] py-2 text-left text-[13px] font-medium text-copy-secondary outline-none transition-[background-color,color] duration-150 hover:bg-morty-fill-opacity-2 active:bg-morty-fill-opacity-3 focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
                onClick={() => showBugReport(daemonSource)}
            >
                <Bug aria-hidden="true" className="size-4 shrink-0" />
                Report a bug
            </button>
        ) : (
            <Button
                aria-label="Report a bug"
                className={appearances[appearance]}
                onClick={() => showBugReport(daemonSource)}
                variant="ghost"
            >
                {appearance === "icon" ? <Bug aria-hidden="true" className="size-4" /> : "Report a bug"}
            </Button>
        );
    return appearance === "icon" ? (
        <Tooltip.Provider delayDuration={150} disableHoverableContent>
            <Tooltip.Root>
                <Tooltip.Trigger asChild>{trigger}</Tooltip.Trigger>
                <Tooltip.Portal>
                    <Tooltip.Content
                        className="z-[70] rounded-lg bg-foreground px-2.5 py-1.5 text-xs text-background shadow-lg"
                        side="top"
                        sideOffset={6}
                    >
                        Report a bug
                        <Tooltip.Arrow className="fill-foreground" />
                    </Tooltip.Content>
                </Tooltip.Portal>
            </Tooltip.Root>
        </Tooltip.Provider>
    ) : (
        trigger
    );
}

/**
 * Renders the shared bug-report dialog for the whole application. Entry-point
 * buttons only trigger `show`; the dialog itself must outlive any single
 * button mount, for example the floating trigger on the loading page that
 * unmounts when loading completes.
 */
export function BugReportDialogHost({ dialog }: { readonly dialog: BugReportDialogStore }) {
    const open = useExternalStore(dialog, (state) => state.open);
    const report = useExternalStore(dialog, (state) => state.report);
    return open && report !== null ? <BugReportDialog dialog={dialog} key="bug-report-dialog" report={report} /> : null;
}

function ReportImage({
    image,
    disabled,
    onRemove,
}: {
    readonly image: BugReportImage;
    readonly disabled: boolean;
    readonly onRemove: () => void;
}) {
    return (
        <li className="relative flex h-[60px] max-w-52 items-center gap-2 rounded-xl border border-border bg-surface-subtle p-2 pr-8 text-xs text-copy-secondary">
            <ObjectUrlImage alt={image.file.name} className="size-11 rounded-lg object-cover" file={image.file} />
            <span className="min-w-0 truncate" title={image.file.name}>
                {image.file.name}
            </span>
            <button
                aria-label={`Remove ${image.file.name}`}
                className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-black/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
                disabled={disabled}
                onClick={onRemove}
                type="button"
            >
                <X aria-hidden="true" className="size-3.5" />
            </button>
        </li>
    );
}

function BugReportDialog({
    dialog,
    report,
}: {
    readonly dialog: BugReportDialogStore;
    readonly report: BugReportStoreApi;
}) {
    const hideBugReport = dialog.getState().hide;
    const { state, description, images, addImages, removeImage, describe, send, close } = useExternalStore(report);
    return (
        <Dialog
            title="Report a bug"
            description="Send a description, optional images and recent technical and network diagnostics to the Morty team. Session text, other files and credentials are not collected automatically."
            onClose={() => {
                close();
                hideBugReport();
            }}
        >
            <AttachCancelBoundary
                cancel={() => {
                    // Unmounting (for example when application loading
                    // completes) only cancels the in-flight send; whether the
                    // dialog stays open belongs to its owner, not the mount
                    // that happened to render it.
                    report.getState().close();
                }}
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
                        onPaste={(event) => {
                            const files = Array.from(event.clipboardData.files);
                            if (files.length > 0) {
                                event.preventDefault();
                                addImages(files);
                            }
                        }}
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
                        {images.length > 0 && (
                            <ul aria-label="Attached images" className="flex flex-wrap gap-2">
                                {images.map((image) => (
                                    <ReportImage
                                        key={image.id}
                                        image={image}
                                        disabled={state.kind === "sending"}
                                        onRemove={() => removeImage(image.id)}
                                    />
                                ))}
                            </ul>
                        )}
                        <div className="space-y-1.5">
                            <HiddenFileInput
                                accept={bugReportImageAccept}
                                ariaLabel="Attach images"
                                disabled={state.kind === "sending"}
                                multiple
                                onFiles={addImages}
                            />
                            <p className="text-xs text-muted-foreground">
                                Paste an image here or choose a file. Up to 3 images, 2.5 MB each. PNG, JPEG, GIF or
                                WebP.
                            </p>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Network and daemon diagnostics are collected automatically and may take up to 10 seconds.
                            You can still send a report when your Runtime is offline.
                        </p>
                        {state.kind === "failed" && <p role="alert">{state.message}</p>}
                        {state.kind === "sending" && <p role="status">Collecting diagnostics and sending…</p>}
                        <Button type="submit" disabled={state.kind === "sending" || description.trim() === ""}>
                            Send report
                        </Button>
                    </form>
                )}
            </AttachCancelBoundary>
        </Dialog>
    );
}
