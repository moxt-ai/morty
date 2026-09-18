import { Ellipsis, ListCollapse } from "lucide-react";
import { useState } from "react";
import { Popover } from "../ui/popover.tsx";

export function ChatComposerMoreMenu({
    compactAvailable,
    compactDisabled,
    onCompact,
}: {
    readonly compactAvailable: boolean;
    readonly compactDisabled: boolean;
    readonly onCompact: () => void;
}) {
    const [open, setOpen] = useState(false);
    const unavailableTitle = "This agent does not provide a compact command.";
    return (
        <Popover.Root onOpenChange={setOpen} open={open}>
            <Popover.Trigger asChild>
                <button
                    aria-label="More options"
                    className="flex size-10 items-center justify-center rounded-full text-copy-secondary outline-none hover:bg-black/[0.045] focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=open]:bg-black/[0.045]"
                    title="More options"
                    type="button"
                >
                    <Ellipsis aria-hidden="true" className="size-5" />
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    align="end"
                    className="z-40 w-56 rounded-2xl border border-[#d5d9dc] bg-white p-1.5 shadow-[0_16px_42px_rgba(0,0,0,0.14)]"
                    role="menu"
                    side="top"
                    sideOffset={10}
                >
                    <button
                        aria-label="Compact context"
                        className="flex min-h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-sm hover:bg-black/[0.06] focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-45"
                        disabled={compactDisabled || !compactAvailable}
                        onClick={() => {
                            setOpen(false);
                            onCompact();
                        }}
                        role="menuitem"
                        title={compactAvailable ? "Compact the agent context" : unavailableTitle}
                        type="button"
                    >
                        <ListCollapse aria-hidden="true" className="size-4 text-copy-secondary" />
                        Compact
                    </button>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
