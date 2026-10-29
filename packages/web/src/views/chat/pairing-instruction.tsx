import { Check, ChevronDown, Copy } from "lucide-react";
import { CopyToClipboardButton } from "../../components/ui/copy-to-clipboard-button.tsx";
import { ExternalLink } from "../../components/ui/external-link.tsx";
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
                    <p className="mt-3 min-h-10 text-center text-sm leading-5 text-morty-text-2">
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
                        className="mt-3 min-h-10 text-center text-sm leading-5 text-morty-text-2"
                        role="status"
                    >
                        Paste into your agent, then open the link it returns.
                    </p>
                }
                value={setupInstruction}
            >
                <Copy aria-hidden="true" className="size-4" />
                <span>Copy setup prompt</span>
            </CopyToClipboardButton>
            <p className="mt-3 text-center text-xs leading-5 text-pretty text-morty-text-3">
                Setup interrupts the agent's current task; continue it here afterwards. Keep that computer awake and
                online.
            </p>
            <details aria-label="Setup details" className="group w-full text-xs leading-5 text-morty-text-3">
                <summary className="mt-5 flex h-6 cursor-pointer list-none items-center justify-center gap-1.5 rounded-lg outline-none hover:text-morty-text-2 keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    Review what setup does
                    <ChevronDown aria-hidden="true" className="size-3.5 group-open:rotate-180" />
                </summary>
                <div className="mt-1 rounded-[16px] border border-border/60 bg-muted/50 p-1 text-left">
                    <ul
                        aria-label="What setup does"
                        className="list-disc space-y-1 py-2 pr-3 pl-7 text-morty-text-3 marker:text-morty-text-4 [&_code]:whitespace-nowrap"
                    >
                        <li>
                            Installs the Mobius CLI (<code>@moxt-ai/mobius</code>) from npm. It updates itself after 30
                            idle minutes.
                        </li>
                        <li>
                            Runs a background connection until restart or <code>mobius quit</code>.
                        </li>
                        <li>Keeps this computer's Morty identity in your user data folder.</li>
                        <li>Asks before replacing a missing connection, which ends earlier shared access.</li>
                        <li>
                            Returns a private link. Anyone who opens it within 24 hours can control your agent until you
                            revoke access.
                        </li>
                    </ul>
                    <p className="px-3 pb-2">
                        <ExternalLink
                            className="text-morty-text-2 hover:text-foreground"
                            href={`${window.location.origin}/setup.md`}
                        >
                            Read setup.md
                        </ExternalLink>
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
