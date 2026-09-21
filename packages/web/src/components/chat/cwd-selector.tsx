import { Check, ChevronDown, ChevronRight, Folder, FolderOpen, LoaderCircle, MapPinPlus, X } from "lucide-react";
import { useState } from "react";
import { dataTestId } from "@/data-testid";
import type { DraftControlsStore } from "@/view-models/chat/draft-controls-store";
import { Button } from "../ui/cloud-button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Popover } from "../ui/popover.tsx";

const WORKING_DIRECTORY_LABEL_LENGTH = 30;

type MiddleTruncation =
    | { readonly kind: "complete"; readonly value: string }
    | { readonly kind: "truncated"; readonly prefix: string; readonly suffix: string };

function middleTruncate(value: string, maximumLength: number): MiddleTruncation {
    if (value.length <= maximumLength) {
        return { kind: "complete", value };
    }
    const marker = "...";
    const retainedLength = maximumLength - marker.length;
    const prefixLength = Math.ceil(retainedLength / 2);
    const suffixLength = Math.floor(retainedLength / 2);
    return {
        kind: "truncated",
        prefix: value.slice(0, prefixLength),
        suffix: value.slice(value.length - suffixLength),
    };
}

export function CwdSelector({
    disabled,
    signal,
    viewModel,
}: {
    readonly disabled: boolean;
    readonly signal: AbortSignal;
    readonly viewModel: DraftControlsStore;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const settings = viewModel.settings;
    if (settings.kind !== "ready") {
        return null;
    }
    const browser = viewModel.cwdBrowser;
    const workingDirectory = settings.cwd.directoryLabel;
    const displayedWorkingDirectory = middleTruncate(workingDirectory, WORKING_DIRECTORY_LABEL_LENGTH);
    const directory = browser.kind === "closed" ? null : browser.directory;
    return (
        <>
            <Popover.Root onOpenChange={setMenuOpen} open={menuOpen}>
                <Popover.Trigger asChild>
                    <button
                        aria-label={`Working directory: ${workingDirectory}`}
                        className="flex h-9 min-w-0 max-w-[200px] items-center gap-2 rounded-lg px-2 text-[13px] text-copy-secondary outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                        data-testid={dataTestId.workingDirectory}
                        disabled={disabled}
                        title={workingDirectory}
                        type="button"
                    >
                        <FolderOpen aria-hidden="true" className="size-4 shrink-0" />
                        {displayedWorkingDirectory.kind === "complete" ? (
                            <span className="min-w-0 overflow-hidden whitespace-nowrap">
                                {displayedWorkingDirectory.value}
                            </span>
                        ) : (
                            <span className="flex min-w-0 items-center whitespace-nowrap">
                                <span className="flex min-w-0 flex-1 overflow-hidden">
                                    <span className="shrink-0">{displayedWorkingDirectory.prefix}</span>
                                </span>
                                <span className="shrink-0">...</span>
                                <span className="flex min-w-0 flex-1 justify-end overflow-hidden">
                                    <span className="shrink-0">{displayedWorkingDirectory.suffix}</span>
                                </span>
                            </span>
                        )}
                        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                    </button>
                </Popover.Trigger>
                <Popover.Portal>
                    <Popover.Content
                        align="start"
                        aria-label="Working directory menu"
                        className="z-50 w-80 overflow-hidden rounded-2xl border border-[#d5d9dc] bg-white p-1.5 shadow-[0_16px_42px_rgba(0,0,0,0.14)]"
                        role="menu"
                        side="top"
                        sideOffset={10}
                    >
                        <div className="max-h-80 overflow-y-auto">
                            {viewModel.recentCwds.map((recent) => (
                                <div className="flex items-center gap-0.5" key={recent.directoryId}>
                                    <button
                                        className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] hover:bg-accent"
                                        data-testid={dataTestId.recentWorkingDirectory}
                                        onClick={() => {
                                            setMenuOpen(false);
                                            void viewModel.selectRecentCwd(recent.directoryId, signal);
                                        }}
                                        role="menuitem"
                                        title={recent.directoryLabel}
                                        type="button"
                                    >
                                        <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0 flex-1 truncate">{recent.directoryLabel}</span>
                                        {recent.directoryId === settings.cwd.directoryId && (
                                            <Check aria-hidden="true" className="size-4 shrink-0" />
                                        )}
                                    </button>
                                    <button
                                        aria-label={`Forget recent working directory ${recent.directoryLabel}`}
                                        className="flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent hover:text-copy-primary"
                                        data-testid={dataTestId.forgetRecentWorkingDirectory}
                                        onClick={() => viewModel.forgetRecentCwd(recent.directoryId)}
                                        role="menuitem"
                                        title="Forget recent location"
                                        type="button"
                                    >
                                        <X aria-hidden="true" className="size-4" />
                                    </button>
                                </div>
                            ))}
                        </div>
                        <div className="mt-1 border-t border-border pt-1">
                            <button
                                className="flex h-10 w-full items-center gap-2 rounded-xl px-2.5 text-left text-[13px] font-medium hover:bg-accent"
                                data-testid={dataTestId.changeWorkingDirectory}
                                onClick={() => {
                                    setMenuOpen(false);
                                    viewModel.openCwd();
                                }}
                                role="menuitem"
                                type="button"
                            >
                                <MapPinPlus aria-hidden="true" className="size-4 text-muted-foreground" />
                                Change to a new location
                            </button>
                        </div>
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>
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
                                data-testid={dataTestId.workingDirectoryPath}
                                onChange={(event) => viewModel.setCwdPath(event.currentTarget.value, signal)}
                                value={browser.path}
                            />
                        </label>
                        <section
                            aria-label={directory === null ? undefined : `Folders in ${directory.directoryLabel}`}
                            className="min-h-56 overflow-hidden rounded-xl border border-border bg-surface-subtle/50"
                            data-testid={dataTestId.workingDirectoryPreview}
                        >
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
                        </section>
                    </div>
                    <footer className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
                        <Button onClick={viewModel.closeCwd} variant="outline">
                            Cancel
                        </Button>
                        <Button
                            data-testid={dataTestId.saveWorkingDirectory}
                            disabled={browser.kind === "loading"}
                            onClick={() => void viewModel.saveCwd(signal)}
                        >
                            Save
                        </Button>
                    </footer>
                </Dialog>
            )}
        </>
    );
}
