import { ChevronRight, Folder, FolderOpen, LoaderCircle } from "lucide-react";
import type { DraftControlsStore } from "@/view-models/chat/draft-controls-store";
import { Button } from "../ui/cloud-button.tsx";
import { Dialog } from "../ui/dialog.tsx";

export function CwdSelector({
    disabled,
    signal,
    viewModel,
}: {
    readonly disabled: boolean;
    readonly signal: AbortSignal;
    readonly viewModel: DraftControlsStore;
}) {
    const settings = viewModel.settings;
    if (settings.kind !== "ready") {
        return null;
    }
    const browser = viewModel.cwdBrowser;
    const workingDirectory = settings.cwd.directoryLabel;
    const directory = browser.kind === "ready" || browser.kind === "failed" ? browser.directory : null;
    return (
        <>
            <button
                aria-label={`Working directory: ${workingDirectory}`}
                className="flex h-9 min-w-0 max-w-[200px] items-center gap-2 rounded-lg px-2 text-[13px] text-copy-secondary outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                disabled={disabled}
                onClick={viewModel.openCwd}
                title={workingDirectory}
                type="button"
            >
                <FolderOpen aria-hidden="true" className="size-4 shrink-0" />
                <span className="truncate">{workingDirectory}</span>
            </button>
            {browser.kind !== "closed" && (
                <Dialog
                    description="Browse folders on the paired machine or enter an absolute folder path."
                    onClose={viewModel.closeCwd}
                    title="Choose working directory"
                >
                    <div className="grid gap-4">
                        <label className="grid gap-1.5">
                            <span className="text-xs font-medium text-copy-tertiary">Working directory path</span>
                            <input
                                aria-label="Working directory path"
                                className="h-10 rounded-lg border border-border bg-white px-3 text-[13px] outline-none focus:border-ring focus:ring-2 focus:ring-ring/15"
                                disabled={browser.kind === "loading"}
                                onChange={(event) => viewModel.setCwdPath(event.currentTarget.value)}
                                value={browser.path}
                            />
                        </label>
                        <div className="min-h-56 overflow-hidden rounded-xl border border-border bg-surface-subtle/50">
                            {browser.kind === "loading" ? (
                                <p
                                    className="flex min-h-56 items-center justify-center gap-2 text-muted-foreground"
                                    role="status"
                                >
                                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                                    Opening folder…
                                </p>
                            ) : (
                                <>
                                    {browser.kind === "failed" && (
                                        <p
                                            className="border-b border-border bg-destructive/5 px-3 py-2 text-xs text-destructive"
                                            role="alert"
                                        >
                                            {browser.message}
                                        </p>
                                    )}
                                    {directory !== null && (
                                        <ul
                                            aria-label={`Folders in ${directory.directoryLabel}`}
                                            className="max-h-64 overflow-y-auto p-2"
                                        >
                                            {directory.parentDirectoryId.length > 0 && (
                                                <li>
                                                    <button
                                                        className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-accent"
                                                        onClick={() =>
                                                            void viewModel.browseCwd(
                                                                directory.parentDirectoryId,
                                                                signal,
                                                            )
                                                        }
                                                        type="button"
                                                    >
                                                        <Folder aria-hidden="true" className="size-4" />
                                                        <span className="flex-1">..</span>
                                                        <ChevronRight aria-hidden="true" className="size-4" />
                                                    </button>
                                                </li>
                                            )}
                                            {directory.entries.map((entry) => (
                                                <li key={entry.directoryId}>
                                                    <button
                                                        aria-label={entry.name}
                                                        className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-accent"
                                                        onClick={() =>
                                                            void viewModel.browseCwd(entry.directoryId, signal)
                                                        }
                                                        type="button"
                                                    >
                                                        <Folder aria-hidden="true" className="size-4" />
                                                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                                                        <ChevronRight aria-hidden="true" className="size-4" />
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                    <footer className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
                        <Button onClick={viewModel.closeCwd} variant="outline">
                            Cancel
                        </Button>
                        <Button disabled={browser.kind === "loading"} onClick={() => void viewModel.saveCwd(signal)}>
                            Save
                        </Button>
                    </footer>
                </Dialog>
            )}
        </>
    );
}
