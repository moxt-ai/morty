import { Copy } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";
import { Button } from "./cloud-button.tsx";
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
    children,
    className = "",
    size,
    variant = "primary",
}: {
    readonly value: string;
    readonly label: string;
    readonly failureToast: { readonly description: string; readonly title: string };
    readonly successToast: { readonly description?: string; readonly title: string };
    readonly children?: ReactNode;
    readonly className?: string;
    readonly size?: ComponentProps<typeof Button>["size"];
    readonly variant?: ComponentProps<typeof Button>["variant"];
}) {
    const [copy, setCopy] = useState<"idle" | "copied">("idle");
    const showToast = useToast();
    const ariaLabel = copy === "copied" ? "Copied" : label;
    const onClick = () => {
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
    };

    if (children !== undefined) {
        return (
            <Button
                aria-label={ariaLabel}
                className={className}
                onClick={onClick}
                {...(size !== undefined ? { size } : {})}
                title={label}
                variant={variant}
            >
                {copy === "copied" ? "Copied" : children}
            </Button>
        );
    }

    return (
        <button aria-label={ariaLabel} title={label} type="button" onClick={onClick}>
            <Copy aria-hidden="true" className="size-4" />
        </button>
    );
}
