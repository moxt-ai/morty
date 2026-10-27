import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

/** Clipboard feedback is transient DOM state; the caller supplies the completed response. */
export function ResponseCopyButton({ text }: { readonly text: string }) {
    const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

    useEffect(() => {
        if (copy !== "copied") {
            return;
        }
        const timer = window.setTimeout(() => setCopy("idle"), 2000);
        return () => window.clearTimeout(timer);
    }, [copy]);

    return (
        <div className="mt-2 flex flex-wrap items-center gap-x-3">
            <button
                aria-label={copy === "copied" ? "Copied" : "Copy response"}
                className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
                onClick={() => {
                    if (navigator.clipboard === undefined) {
                        setCopy("failed");
                        return;
                    }
                    void navigator.clipboard.writeText(text).then(
                        () => setCopy("copied"),
                        () => setCopy("failed"),
                    );
                }}
                title="Copy response as Markdown"
                type="button"
            >
                {copy === "copied" ? (
                    <Check aria-hidden="true" className="size-3.5" />
                ) : (
                    <Copy aria-hidden="true" className="size-3.5" />
                )}
                {copy === "copied" ? "Copied" : copy === "failed" ? "Retry copy" : "Copy"}
            </button>
            <span className="sr-only" role="status">
                {copy === "copied" ? "Response copied to clipboard" : ""}
            </span>
            {copy === "failed" && (
                <span className="text-xs text-muted-foreground" role="alert">
                    Could not access the clipboard. Try again or select the response and copy it manually.
                </span>
            )}
        </div>
    );
}
