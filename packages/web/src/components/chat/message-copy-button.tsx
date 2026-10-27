import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function MessageCopyButton({ text }: { readonly text: string }) {
    const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
    const label = copy === "copied" ? "Copied" : copy === "failed" ? "Copy unavailable" : "Copy message";
    return (
        <button
            aria-label={label}
            className="invisible absolute -bottom-7 right-1 z-10 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-black/[0.045] hover:text-foreground focus:visible focus:opacity-100 keyboard-focus:focus-visible:ring-2 keyboard-focus:focus-visible:ring-ring/60 group-hover/message:visible group-hover/message:opacity-100 group-focus-within/message:visible group-focus-within/message:opacity-100 motion-reduce:transition-none"
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
            title={label}
            type="button"
        >
            {copy === "copied" ? (
                <Check aria-hidden="true" className="size-3.5" />
            ) : (
                <Copy aria-hidden="true" className="size-3.5" />
            )}
        </button>
    );
}
