import { Link, Send } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "./cloud-button.tsx";
import { CopyToClipboardButton } from "./copy-to-clipboard-button.tsx";
import { useToast } from "./toast.tsx";

/**
 * Sends a link to another device: through the system share sheet when the browser offers one, otherwise by
 * copying it. `onSent` runs once the share completes or the link is copied, never when the person dismisses the
 * share sheet.
 */
export function SendLinkButton({
    className = "",
    label,
    onSent,
    share,
    shareData,
    size,
}: {
    readonly className?: string;
    readonly label: { readonly share: string; readonly copy: string };
    readonly onSent: () => void;
    readonly share: ((data: ShareData) => Promise<void>) | null;
    readonly shareData: { readonly text: string; readonly title: string; readonly url: string };
    readonly size?: ComponentProps<typeof Button>["size"];
}) {
    const showToast = useToast();
    const unavailable = { description: "Copy this page's address from your browser instead.", title: "Could not send" };
    if (share === null) {
        return (
            <CopyToClipboardButton
                className={className}
                failureToast={unavailable}
                label={label.copy}
                onCopied={onSent}
                {...(size === undefined ? {} : { size })}
                successToast={{ description: "Open it on the computer where your agent runs.", title: "Link copied" }}
                value={shareData.url}
            >
                <Link aria-hidden="true" className="size-4" />
                <span>{label.copy}</span>
            </CopyToClipboardButton>
        );
    }
    return (
        <Button
            className={className}
            onClick={() => {
                void share({ ...shareData }).then(onSent, (cause: unknown) => {
                    // Dismissing the share sheet is a cancellation, not a failure.
                    if (cause instanceof DOMException && cause.name === "AbortError") {
                        return;
                    }
                    showToast(unavailable);
                });
            }}
            {...(size === undefined ? {} : { size })}
        >
            <Send aria-hidden="true" className="size-4" />
            <span>{label.share}</span>
        </Button>
    );
}
