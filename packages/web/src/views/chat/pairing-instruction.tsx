import { Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { useToast } from "../../components/ui/toast.tsx";
import { dataTestId } from "../../data-testid.ts";

export function PairingInstruction() {
    const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
    const showToast = useToast();
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
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Copy setup instruction"
                    title="Copy setup instruction"
                    onClick={() => {
                        void navigator.clipboard.writeText(setupInstruction).then(
                            () => {
                                setCopy("copied");
                                showToast({ title: "Copied", variant: "success" });
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
                    <Copy aria-hidden="true" className="size-4" />
                </Button>
            </div>
            {copy === "failed" && (
                <p className="text-xs text-muted-foreground">Select the instruction to copy it manually.</p>
            )}
        </div>
    );
}
