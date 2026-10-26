import { ChevronDown, Copy } from "lucide-react";
import { CopyToClipboardButton } from "../../components/ui/copy-to-clipboard-button.tsx";
import { dataTestId } from "../../data-testid.ts";
import { setupPrimaryButtonClassName, setupPrimaryButtonSize } from "../setup/setup-card-shell.tsx";

export function PairingInstruction() {
    const setupInstruction = `Fetch ${window.location.origin}/setup.md and set up Morty for me.`;
    return (
        <div>
            <CopyToClipboardButton
                className={`${setupPrimaryButtonClassName} min-h-12 !text-foreground`}
                failureToast={{
                    description: "Open View setup prompt to copy it manually.",
                    title: "Could not copy",
                }}
                label="Copy setup prompt"
                size={setupPrimaryButtonSize}
                successToast={{
                    description: "Paste into your agent, then open the link it returns.",
                    title: "Copied",
                }}
                idleContent={
                    <p className="mt-3 min-h-10 text-center text-sm leading-5 text-muted-foreground">
                        Paste the prompt into the agent on your computer.
                    </p>
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
            <div className="mt-3 text-center text-xs leading-5 text-muted-foreground">
                <p>Your agent keeps running on its original computer. Keep it awake and online.</p>
                <p className="mt-2">Setup may install or update the local connection software.</p>
            </div>
            <details aria-label="Setup prompt" className="group mt-3 text-xs leading-5 text-muted-foreground">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-center gap-1.5 rounded-lg outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    View setup prompt
                    <ChevronDown aria-hidden="true" className="size-3.5 group-open:rotate-180" />
                </summary>
                <textarea
                    aria-label="Agent setup prompt"
                    data-testid={dataTestId.pairingInstruction}
                    readOnly
                    rows={4}
                    value={setupInstruction}
                    onFocus={(event) => event.currentTarget.select()}
                    className="mt-2 w-full resize-none rounded-xl border border-border bg-muted/40 px-4 py-3 font-mono text-xs leading-5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
            </details>
        </div>
    );
}
