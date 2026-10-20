import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { useToast } from "../../components/ui/toast.tsx";
import { dataTestId } from "../../data-testid.ts";
import { setupMonoFieldClassName, setupPrimaryButtonClassName } from "../setup/setup-card-shell.tsx";

export function PairingInstruction() {
    const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
    const showToast = useToast();
    const setupInstruction = `Fetch ${window.location.origin}/setup.md and set up Morty for me. Don't ask me anything.`;
    return (
        <div className="space-y-3">
            <textarea
                aria-label="Agent setup instruction"
                data-testid={dataTestId.pairingInstruction}
                readOnly
                rows={3}
                value={setupInstruction}
                onFocus={(event) => event.currentTarget.select()}
                className={`${setupMonoFieldClassName} field-sizing-content`}
            />
            <Button
                type="button"
                variant="primary"
                className={setupPrimaryButtonClassName}
                onClick={() => {
                    if (navigator.clipboard === undefined) {
                        setCopy("failed");
                        showToast({
                            description: "Select the instruction and copy it manually.",
                            title: "Could not copy",
                            variant: "error",
                        });
                        return;
                    }
                    void navigator.clipboard.writeText(setupInstruction).then(
                        () => {
                            setCopy("copied");
                            showToast({
                                description:
                                    "Paste it into your coding agent on your computer, then open the link it returns.",
                                title: "Copied",
                                variant: "success",
                            });
                        },
                        () => {
                            setCopy("failed");
                            showToast({
                                description: "Select the instruction and copy it manually.",
                                title: "Could not copy",
                                variant: "error",
                            });
                        },
                    );
                }}
            >
                {copy === "copied" ? "Copied" : "Copy setup instruction"}
                {copy === "copied" ? (
                    <Check aria-hidden="true" className="size-4" />
                ) : (
                    <Copy aria-hidden="true" className="size-4" />
                )}
            </Button>
            {copy === "failed" && (
                <p className="text-xs text-muted-foreground">
                    Could not copy. Select the instruction and copy it manually.
                </p>
            )}
        </div>
    );
}
