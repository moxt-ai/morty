import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/cloud-button.tsx";

/** Copies a sharing link and owns the dialog-local confirmation and fallback state. */
export function CopyLinkButton({ url }: { readonly url: string }) {
    const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
    return (
        <div className="space-y-2">
            <Button
                variant="outline"
                onClick={() => {
                    if (navigator.clipboard === undefined) {
                        setCopy("failed");
                        return;
                    }
                    void navigator.clipboard.writeText(url).then(
                        () => setCopy("copied"),
                        () => setCopy("failed"),
                    );
                }}
            >
                {copy === "copied" ? (
                    <Check aria-hidden="true" className="size-4" />
                ) : (
                    <Copy aria-hidden="true" className="size-4" />
                )}
                <span>{copy === "copied" ? "Copied" : "Copy link"}</span>
            </Button>
            {copy === "failed" && (
                <p className="break-all font-mono text-xs text-muted-foreground" role="alert">
                    Could not copy the link. Copy it manually: {url}
                </p>
            )}
        </div>
    );
}
