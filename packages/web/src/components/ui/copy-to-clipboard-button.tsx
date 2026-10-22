import { Copy } from "lucide-react";
import { useState } from "react";
import { useToast } from "./toast.tsx";

/**
 * A copy affordance for a single text value with copied/failed feedback
 * reported through the toast host. Pure UI: callers own the text and labels;
 * the failure toast tells the user to copy manually when the write is denied.
 */
export function CopyToClipboardButton({
    value,
    label,
    failureToast,
    successToast,
}: {
    readonly value: string;
    readonly label: string;
    readonly failureToast: { readonly description: string; readonly title: string };
    readonly successToast: { readonly description?: string; readonly title: string };
}) {
    const [copy, setCopy] = useState<"idle" | "copied">("idle");
    const showToast = useToast();
    return (
        <button
            aria-label={copy === "copied" ? "Copied" : label}
            title={label}
            type="button"
            onClick={() => {
                if (navigator.clipboard === undefined) {
                    showToast(failureToast);
                    return;
                }
                void navigator.clipboard.writeText(value).then(
                    () => {
                        setCopy("copied");
                        showToast(successToast);
                    },
                    () => showToast(failureToast),
                );
            }}
        >
            <Copy aria-hidden="true" className="size-4" />
        </button>
    );
}
