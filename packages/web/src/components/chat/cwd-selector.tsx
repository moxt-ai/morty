import { Check, ChevronRight, Folder, FolderOpen, LoaderCircle, MapPinPlus, X } from "lucide-react";
import { Tooltip } from "radix-ui";
import { dataTestId } from "@/data-testid";
import { cn } from "@/lib/utils";
import type { DraftControlsStore } from "@/view-models/chat/draft-controls-store";
import { Button } from "../ui/cloud-button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { MortyTooltipContent } from "../ui/morty-tooltip-content.tsx";
import { overlaySurfaceRadiusClassName } from "../ui/overlay-surface.ts";
import { Popover } from "../ui/popover.tsx";
import { ScrollEdgeFade } from "../utils/scroll-edge-fade.tsx";
import { StartClippedLabel } from "../utils/start-clipped-label.tsx";

const workingDirectoryTriggerBaseClassName =
    "flex h-9 min-w-0 max-w-[200px] items-center gap-2 rounded-lg px-2 text-[13px] text-copy-secondary outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none";

const workingDirectoryTriggerInteractiveClassName = `${workingDirectoryTriggerBaseClassName} hover:bg-accent data-[state=open]:bg-accent disabled:cursor-not-allowed disabled:opacity-50`;

export function ReadonlyWorkingDirectory({ directoryLabel }: { readonly directoryLabel: string }) {
    return (
        <Tooltip.Provider delayDuration={150}>
            <Tooltip.Root>
                <Tooltip.Trigger asChild>
                    <span
                        className={workingDirectoryTriggerBaseClassName}
                        data-testid={dataTestId.workingDirectory}
                        title={directoryLabel}
                    >
                        <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
                        <StartClippedLabel value={directoryLabel} />
                    </span>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                    <MortyTooltipContent className="max-w-80 break-all px-3 py-2 leading-5" side="top" sideOffset={8}>
                        {directoryLabel}
                        <Tooltip.Arrow className="fill-foreground" />
                    </MortyTooltipContent>
                </Tooltip.Portal>
            </Tooltip.Root>
        </Tooltip.Provider>
    );
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
    const settings = viewModel.settings;
    if (settings.kind !== "ready") {
        return null;
    }
    const browser = viewModel.cwdBrowser;
    const workingDirectory = settings.cwd.directoryLabel;
    const directory = browser.kind === "closed" ? null : browser.directory;
    const directoryNavigationDisabled = browser.kind === "previewing";
    const directoryPending = browser.kind === "loading" || browser.kind === "previewing";
    return (
        <>
            <Popover.Root onOpenChange={viewModel.setCwdMenuOpen} open={viewModel.cwdMenuOpen}>
                <Tooltip.Provider delayDuration={150}>
                    <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                            <Popover.Trigger asChild>
                                <button
                                    aria-label={`Working directory: ${workingDirectory}`}
                                    className={workingDirectoryTriggerInteractiveClassName}
                                    data-testid={dataTestId.workingDirectory}
                                    disabled={disabled}
                                    type="button"
                                >
                                    <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
                                    <StartClippedLabel value={workingDirectory} />
                                </button>
                            </Popover.Trigger>
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                            <MortyTooltipContent
                                className="max-w-80 break-all px-3 py-2 leading-5"
                                side="top"
                                sideOffset={8}
                            >
                                {workingDirectory}
                                <Tooltip.Arrow className="fill-foreground" />
                            </MortyTooltipContent>
                        </Tooltip.Portal>
                    </Tooltip.Root>
                </Tooltip.Provider>
                <Popover.Portal>
                    <Popover.Content
                        align="start"
                        aria-label="Working directory menu"
                        className={cn(
                            "z-50 w-80 overflow-hidden border border-[#d5d9dc] bg-white p-1.5 shadow-[0_16px_42px_rgba(0,0,0,0.14)]",
                            overlaySurfaceRadiusClassName,
                        )}
                        role="menu"
                        side="top"
                        sideOffset={10}
                    >
                        <ScrollEdgeFade
                            fadeFromClassName="from-white"
                            fadeToClassName="to-white/0"
                            className="max-h-80 overflow-y-auto"
                        >
                            {viewModel.recentCwds.map((recent) => (
                                <div className="flex items-center gap-0.5" key={recent.directoryId}>
                                    <button
                                        className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] hover:bg-accent"
                                        data-testid={dataTestId.recentWorkingDirectory}
                                        onClick={() => {
                                            viewModel.setCwdMenuOpen(false);
                                            void viewModel.selectRecentCwd(recent.directoryId, signal);
                                        }}
                                        role="menuitem"
                                        title={recent.directoryLabel}
                                        type="button"
                                    >
                                        <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                                        <StartClippedLabel value={recent.directoryLabel} />
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
                        </ScrollEdgeFade>
                        <div className="mt-1 border-t border-border pt-1">
                            <button
                                className="flex h-10 w-full items-center gap-2 rounded-xl px-2.5 text-left text-[13px] font-medium hover:bg-accent"
                                data-testid={dataTestId.changeWorkingDirectory}
                                onClick={() => {
                                    viewModel.setCwdMenuOpen(false);
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
                    description="Browse folders on your local machine or enter an absolute folder path."
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
                            aria-busy={directoryPending}
                            aria-disabled={directoryNavigationDisabled}
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
                                        <ScrollEdgeFade
                                            scrollElement="ul"
                                            aria-label={`Folders in ${directory.directoryLabel}`}
                                            revealSurface
                                            edgeStroke={{ className: "border-surface-subtle/50", placement: "inside" }}
                                            frameClassName={directoryNavigationDisabled ? "opacity-50" : ""}
                                            className="max-h-64 overflow-y-auto p-2"
                                        >
                                            {directory.parentDirectoryId.length > 0 && (
                                                <li>
                                                    <button
                                                        className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-accent disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                                        disabled={directoryNavigationDisabled}
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
                                                        className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-accent disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                                        disabled={directoryNavigationDisabled}
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
                                        </ScrollEdgeFade>
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
                            disabled={directoryPending}
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
