import { Check, ChevronDown, Copy } from "lucide-react";
import { CopyToClipboardButton } from "../../components/ui/copy-to-clipboard-button.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { dataTestId } from "../../data-testid.ts";
import { setupPrimaryButtonClassName, setupPrimaryButtonSize } from "../setup/setup-card-shell.tsx";

export function PairingInstruction() {
    const setupInstruction = `Fetch ${window.location.origin}/setup.md and set up Morty for me. You may install missing prerequisites and pair this machine. Complete setup without asking questions.`;
    return (
        <div>
            <CopyToClipboardButton
                className={setupPrimaryButtonClassName}
                failureToast={{
                    description: "Expand setup details to copy the prompt manually.",
                    title: "Could not copy",
                }}
                label="Copy setup prompt"
                size={setupPrimaryButtonSize}
                successToast={{
                    description: "Paste into your agent, then open the link it returns.",
                    title: "Copied",
                }}
                idleContent={
                    <p className="mt-3 min-h-10 text-center text-sm leading-5 text-foreground">
                        Next: paste it into the agent running on your computer.
                    </p>
                }
                copiedContent={
                    <>
                        <Check aria-hidden="true" className="size-4" />
                        Copied
                    </>
                }
                successContent={
                    <p
                        aria-label="Setup next step"
                        aria-atomic="true"
                        className="mt-3 min-h-10 text-center text-sm leading-5 text-foreground"
                        role="status"
                    >
                        Paste into your agent, then open the link it returns.
                    </p>
                }
                value={setupInstruction}
            >
                <Copy aria-hidden="true" className="size-4" />
                Copy setup prompt
            </CopyToClipboardButton>
            <div className="mt-3 rounded-[16px] bg-muted/50 px-4 py-2 text-center text-xs leading-5 text-morty-text-3">
                <p>Setup interrupts the agent's current task. Continue it in your browser afterwards.</p>
                <p>Keep that computer awake and online while using Morty.</p>
            </div>
            <details aria-label="Setup details" className="group w-full text-xs leading-5 text-morty-text-3">
                <summary className="mt-4 flex h-6 cursor-pointer list-none items-center justify-center gap-1.5 rounded-lg outline-none hover:text-morty-text-2 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    Review setup details
                    <ChevronDown aria-hidden="true" className="size-3.5 group-open:rotate-180" />
                </summary>
                <div className="mt-1 rounded-[16px] border border-border/60 bg-muted/50 p-1 text-left">
                    <p className="px-3 py-1 text-morty-text-3">
                        Setup may install or update Morty's local connection software.
                    </p>
                    <div className="overflow-hidden rounded-[12px] bg-muted">
                        <Textarea
                            aria-label="Agent setup prompt"
                            className="min-h-0 [field-sizing:content] cursor-text rounded-[12px] bg-background p-3 text-[12px] leading-5 text-morty-text-2 lg:text-[12px]"
                            data-testid={dataTestId.pairingInstruction}
                            readOnly
                            rows={1}
                            value={setupInstruction}
                            onFocus={(event) => event.currentTarget.select()}
                        />
                    </div>
                </div>
            </details>
        </div>
    );
}
