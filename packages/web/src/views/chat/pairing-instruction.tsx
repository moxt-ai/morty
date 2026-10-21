import { CopyToClipboardButton } from "../../components/ui/copy-to-clipboard-button.tsx";
import { dataTestId } from "../../data-testid.ts";

export function PairingInstruction() {
    const setupInstruction = `Fetch ${window.location.origin}/setup.md and set up Morty for me. Don't ask me anything.`;
    return (
        <div className="mt-8 space-y-3">
            <div className="flex items-center gap-2">
                <textarea
                    aria-label="Agent setup instruction"
                    data-testid={dataTestId.pairingInstruction}
                    readOnly
                    rows={2}
                    value={setupInstruction}
                    onFocus={(event) => event.currentTarget.select()}
                    className="min-w-0 flex-1 resize-none rounded-xl border border-border bg-muted/40 p-4 font-mono text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <CopyToClipboardButton
                    value={setupInstruction}
                    label="Copy setup instruction"
                    failureToast={{
                        description: "Select the instruction and copy it manually.",
                        title: "Could not copy",
                    }}
                    successToast={{
                        description: "Paste it into your coding agent on your computer, then open the link it returns.",
                        title: "Copied",
                    }}
                />
            </div>
        </div>
    );
}
