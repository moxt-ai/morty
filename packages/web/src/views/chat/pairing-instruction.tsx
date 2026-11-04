import { Check, Copy, Link, Send } from "lucide-react";
import {
    SetupPromptCopiedHint,
    SetupPromptDetails,
    SetupPromptIdleHint,
} from "../../components/setup/setup-prompt-guidance.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { CopyToClipboardButton } from "../../components/ui/copy-to-clipboard-button.tsx";
import { agentSetupPrompt } from "../../services/device/setup-handoff.ts";
import { useExternalStore } from "../../view-models/external-store.ts";
import type { SendLinkStoreApi, SetupHandoffModel } from "../../view-models/send-link-store.ts";
import { setupPrimaryButtonClassName, setupPrimaryButtonSize } from "../setup/setup-card-shell.tsx";

const copyPrompt: SetupHandoffModel = { kind: "copy-prompt" };
const handoffHint = "Setup runs on your computer. Open Morty there to copy the prompt.";
const handoffHintClassName = "mt-3 min-h-10 text-center text-sm leading-5 text-morty-text-2";
const unavailableLink = { description: "Copy this page's address from your browser instead.", title: "Could not send" };

function mortyAddress(): string {
    return `${window.location.origin}/`;
}

/** A phone or tablet cannot run setup, so it sends Morty's address to the computer through the share sheet. */
function ShareSetupLink({ sendLink }: { readonly sendLink: SendLinkStoreApi }) {
    const { send, state } = useExternalStore(sendLink);
    return (
        <>
            <Button
                aria-busy={state.kind === "sending"}
                className={setupPrimaryButtonClassName}
                disabled={state.kind === "sending"}
                onClick={() =>
                    send({
                        text: "Set up Morty on the computer where your agent runs.",
                        title: "Morty",
                        url: mortyAddress(),
                    })
                }
                size={setupPrimaryButtonSize}
            >
                <Send aria-hidden="true" className="size-4" />
                <span>Send to my computer</span>
            </Button>
            {state.kind === "failed" ? (
                <p className={handoffHintClassName} role="status">
                    Could not open sharing. Copy this page's address from your browser instead.
                </p>
            ) : (
                <p className={handoffHintClassName}>{handoffHint}</p>
            )}
        </>
    );
}

export function PairingInstruction({
    handoff = copyPrompt,
    onCopied,
    onLinkSent = () => {},
}: {
    /** How this device moves setup to the agent's computer; copying the prompt unless the caller knows better. */
    readonly handoff?: SetupHandoffModel;
    readonly onCopied?: () => void;
    readonly onLinkSent?: () => void;
}) {
    const setupInstruction = agentSetupPrompt();
    return (
        <div>
            {handoff.kind === "share" ? (
                <ShareSetupLink sendLink={handoff.sendLink} />
            ) : handoff.kind === "copy-link" ? (
                <>
                    <CopyToClipboardButton
                        className={setupPrimaryButtonClassName}
                        failureToast={unavailableLink}
                        label="Copy link"
                        onCopied={onLinkSent}
                        size={setupPrimaryButtonSize}
                        successToast={{
                            description: "Open it on the computer where your agent runs.",
                            title: "Link copied",
                        }}
                        value={mortyAddress()}
                    >
                        <Link aria-hidden="true" className="size-4" />
                        <span>Copy link</span>
                    </CopyToClipboardButton>
                    <p className={handoffHintClassName}>{handoffHint}</p>
                </>
            ) : (
                <CopyToClipboardButton
                    className={setupPrimaryButtonClassName}
                    failureToast={{
                        description: "Expand setup details to copy the prompt manually.",
                        title: "Could not copy",
                    }}
                    label="Copy setup prompt"
                    {...(onCopied === undefined ? {} : { onCopied })}
                    size={setupPrimaryButtonSize}
                    successToast={{
                        description: "Paste into your agent, then open the link it returns.",
                        title: "Copied",
                    }}
                    idleContent={<SetupPromptIdleHint />}
                    copiedContent={
                        <>
                            <Check aria-hidden="true" className="size-4" />
                            Copied
                        </>
                    }
                    successContent={<SetupPromptCopiedHint />}
                    value={setupInstruction}
                >
                    <Copy aria-hidden="true" className="size-4" />
                    <span>Copy setup prompt</span>
                </CopyToClipboardButton>
            )}
            <SetupPromptDetails prompt={setupInstruction} />
        </div>
    );
}
