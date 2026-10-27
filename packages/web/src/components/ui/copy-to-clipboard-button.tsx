import { Copy } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button } from "./cloud-button.tsx";
import { useToast } from "./toast.tsx";

/** How long the button reports the copy before returning to its idle affordance. */
const CONFIRMATION_MILLISECONDS = 2_000;

/**
 * `confirming` is the short-lived button feedback; `confirmed` keeps the
 * caller's next-step guidance visible after the button has returned to idle.
 */
type CopyFeedback = { readonly kind: "idle" } | { readonly kind: "confirming" } | { readonly kind: "confirmed" };

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
    successContent,
    idleContent,
    copiedContent,
    children,
    className = "",
    size,
    variant = "primary",
}: {
    readonly value: string;
    readonly label: string;
    readonly failureToast: { readonly description: string; readonly title: string };
    readonly successToast: { readonly description?: string; readonly title: string };
    /** Inline feedback for a next step that should stay visible instead of a toast. */
    readonly successContent?: ReactNode;
    /** Guidance occupying the same place before the copy succeeds. */
    readonly idleContent?: ReactNode;
    /** Button contents shown after a successful copy. */
    readonly copiedContent?: ReactNode;
    readonly children?: ReactNode;
    readonly className?: string;
    readonly size?: ComponentProps<typeof Button>["size"];
    readonly variant?: ComponentProps<typeof Button>["variant"];
}) {
    const [feedback, setFeedback] = useState<CopyFeedback>({ kind: "idle" });
    const showToast = useToast();
    const confirming = feedback.kind === "confirming";
    const ariaLabel = confirming ? "Copied" : label;
    useEffect(() => {
        if (feedback.kind !== "confirming") {
            return;
        }
        const timeout = window.setTimeout(() => setFeedback({ kind: "confirmed" }), CONFIRMATION_MILLISECONDS);
        return () => window.clearTimeout(timeout);
    }, [feedback]);
    const onClick = () => {
        if (navigator.clipboard === undefined) {
            showToast(failureToast);
            return;
        }
        void navigator.clipboard.writeText(value).then(
            () => {
                setFeedback({ kind: "confirming" });
                if (successContent === undefined) {
                    showToast(successToast);
                }
            },
            () => showToast(failureToast),
        );
    };

    if (children !== undefined) {
        return (
            <>
                <Button
                    aria-label={ariaLabel}
                    className={className}
                    onClick={onClick}
                    {...(size !== undefined ? { size } : {})}
                    title={label}
                    variant={variant}
                >
                    {confirming ? (copiedContent ?? "Copied") : children}
                </Button>
                {feedback.kind === "idle" ? idleContent : successContent}
            </>
        );
    }

    return (
        <button aria-label={ariaLabel} title={label} type="button" onClick={onClick}>
            <Copy aria-hidden="true" className="size-4" />
        </button>
    );
}
