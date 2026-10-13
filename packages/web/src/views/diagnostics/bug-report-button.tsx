import { Bug, Paperclip, X } from "lucide-react";
import { Tooltip } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { sentryBugReportSink } from "../../services/diagnostics/bug-report.ts";
import { type BugReportImage, bugReportImageAccept, createBugReportStore } from "../../view-models/bug-report-store.ts";

const appearances = {
    floating: "fixed bottom-2 right-2 z-40 bg-background/90 text-xs",
    icon: "size-10 shrink-0 justify-center rounded-full px-0 text-copy-secondary hover:bg-white/70",
    labelled: "min-h-10 shrink-0 text-xs",
};

export function BugReportButton({ appearance = "labelled" }: { readonly appearance?: keyof typeof appearances }) {
    const [open, setOpen] = useState(false);
    const trigger = (
        <Button
            aria-label="Report a bug"
            className={appearances[appearance]}
            onClick={() => setOpen(true)}
            variant="ghost"
        >
            {appearance === "icon" ? <Bug aria-hidden="true" className="size-4" /> : "Report a bug"}
        </Button>
    );
    return (
        <>
            {appearance === "icon" ? (
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
            )}
            {open && <BugReportDialog onClose={() => setOpen(false)} />}
        </>
    );
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
    const [source, setSource] = useState("");
    useEffect(() => {
        const url = URL.createObjectURL(image.file);
        setSource(url);
        return () => URL.revokeObjectURL(url);
    }, [image.file]);
    return (
        <li className="relative flex h-[60px] max-w-52 items-center gap-2 rounded-xl border border-border bg-surface-subtle p-2 pr-8 text-xs text-copy-secondary">
            {source && <img alt={image.file.name} src={source} className="size-11 rounded-lg object-cover" />}
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

function BugReportDialog({ onClose }: { readonly onClose: () => void }) {
    const [store] = useState(() => createBugReportStore(sentryBugReportSink));
    const { state, description, images, addImages, removeImage, describe, send, close } = useStore(store);
    const fileInput = useRef<HTMLInputElement>(null);
    useEffect(() => close, [close]);
    return (
        <Dialog
            title="Report a bug"
            description="Send a description, optional images and recent technical diagnostics to the Morty team. Conversation text, other files and credentials are not collected automatically."
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
                        <input
                            ref={fileInput}
                            type="file"
                            aria-label="Attach images"
                            accept={bugReportImageAccept}
                            multiple
                            hidden
                            disabled={state.kind === "sending"}
                            onChange={(event) => {
                                addImages(Array.from(event.target.files ?? []));
                                event.target.value = "";
                            }}
                        />
                        <Button
                            variant="ghost"
                            size="sm"
                            disabled={state.kind === "sending" || images.length >= 3}
                            onClick={() => fileInput.current?.click()}
                        >
                            <Paperclip aria-hidden="true" className="size-4" />
                            Attach images
                        </Button>
                        <p className="text-xs text-muted-foreground">
                            Paste an image here or choose a file. Up to 3 images, 2.5 MB each. PNG, JPEG, GIF or WebP.
                        </p>
                    </div>
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
