import { Archive, type LucideIcon, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { dataTestId } from "../../data-testid.ts";
import { LinkButton } from "../ui/link-button.tsx";
import { MortyAlert, type MortyAlertTone } from "../ui/morty-alert.tsx";
import type { ConnectionFeedback } from "./execution-context.ts";

type VisibleFeedback = Exclude<ConnectionFeedback, { readonly kind: "hidden" }>;
type ClosedFeedback = Extract<ConnectionFeedback, { readonly kind: "closed" }>;
function noticeTestId(feedback: ConnectionFeedback): string {
    return feedback.kind === "closed" ? dataTestId.sessionClosedNotice : dataTestId.sessionReconnectNotice;
}

/**
 * Surface for a connection state, matching the tone rules shared by every other
 * notice in the product: failures read as errors, everything else is neutral.
 */
function noticeTone(feedback: VisibleFeedback): MortyAlertTone {
    const failed = feedback.kind === "failed" || (feedback.kind === "closed" && feedback.reopen === "failed");
    return failed ? "error" : "neutral";
}

/** The leading icon names the connection state, so it can stand in for the tone's default icon. */
function noticeIcon(feedback: VisibleFeedback): LucideIcon | undefined {
    if (feedback.kind === "closed") {
        // A failed reopen is a failure, so it keeps the error tone's own icon.
        return feedback.reopen === "failed" ? undefined : Archive;
    }
    return feedback.kind === "retrying" || feedback.kind === "waiting" ? WifiOff : undefined;
}

function RetryAction({ className, onClick }: { readonly className: string; readonly onClick: () => void }) {
    return (
        <LinkButton className={className} onClick={onClick}>
            Retry now
        </LinkButton>
    );
}

function ReopenAction({
    className,
    feedback,
    onReopen,
}: {
    readonly className: string;
    readonly feedback: ClosedFeedback;
    readonly onReopen: () => void;
}) {
    return (
        <LinkButton
            className={className}
            disabled={feedback.reopen === "reopening" || feedback.reopen === "offline"}
            onClick={onReopen}
        >
            {feedback.reopen === "reopening" ? "Reopening…" : "Reopen it"}
        </LinkButton>
    );
}

function retryButton(feedback: VisibleFeedback, onRetryNow: () => void, className: string): ReactNode {
    if (feedback.kind !== "retrying" && feedback.kind !== "failed") {
        return null;
    }
    return <RetryAction className={className} onClick={onRetryNow} />;
}

function countdown(feedback: VisibleFeedback): ReactNode {
    if (feedback.kind !== "retrying" || feedback.remainingSeconds === null) {
        return null;
    }
    return <span className="tabular-nums">Retrying in {feedback.remainingSeconds} s</span>;
}

export function ConnectionNotice({
    feedback,
    footer,
    inline = false,
    onRetryNow,
    onReopen,
}: {
    readonly feedback: ConnectionFeedback;
    /**
     * Single muted status line for embedding inside another notice: the host
     * notice already carries the headline, so the title and block chrome here
     * would only repeat it and stack a second hierarchy inside the first.
     */
    readonly inline?: boolean;
    /** Extra action line, such as switching to another online computer. */
    readonly footer?: ReactNode;
    readonly onRetryNow: () => void;
    readonly onReopen: () => void;
}) {
    if (feedback.kind === "hidden") {
        return null;
    }
    // No text size here: the row already sets text-12, and passing a custom text-*
    // token through LinkButton's tailwind-merge would evict its text-primary color.
    const actionClassName = inline ? "min-h-5" : "min-h-11 sm:min-h-5";
    const retry = retryButton(feedback, onRetryNow, actionClassName);
    const reopen =
        feedback.kind === "closed" ? (
            <ReopenAction className={actionClassName} feedback={feedback} onReopen={onReopen} />
        ) : null;
    const testId = noticeTestId(feedback);

    // The waiting state reads as a quiet chip, not a card: title only, in a
    // button-like shape on the chat surface so it sits left-aligned with the
    // composer instead of spanning the pane. The trailing ellipsis animates
    // dot by dot; the clipped span keeps its full width so layout never shifts.
    if (feedback.kind === "waiting" && !inline) {
        const title = feedback.title.endsWith("…") ? feedback.title.slice(0, -1) : feedback.title;
        return (
            <div
                className="flex h-9 w-fit items-center rounded-[24px] bg-surface-elevated px-4 text-12 font-medium text-morty-text-2"
                data-testid={testId}
            >
                <span>{title}</span>
                {title !== feedback.title && (
                    // Three periods, not the single ellipsis glyph: the clip-path
                    // thirds line up with each period's advance, so the loop
                    // starts at exactly one dot.
                    <span aria-hidden="true" className="animate-reconnect-ellipsis motion-reduce:animate-none">
                        ...
                    </span>
                )}
            </div>
        );
    }

    if (inline) {
        return (
            <div
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-12 font-normal"
                data-testid={testId}
            >
                <span className="min-w-0">
                    {feedback.kind === "closed" ? "The session is closed." : feedback.description}
                </span>
                {countdown(feedback)}
                {retry}
                {reopen}
            </div>
        );
    }

    // The host alert owns the surface, the live region and the headline: this
    // component fills its two slots instead of stacking its own heading block
    // inside the alert's, so connection states read exactly like every other
    // notice (tone ink for the headline, muted text for the detail line).
    const detail = (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 font-normal">
            <span className="min-w-0">{feedback.description}</span>
            {countdown(feedback)}
            {retry}
            {reopen}
        </div>
    );
    return (
        <MortyAlert
            description={
                footer === undefined ? (
                    detail
                ) : (
                    <>
                        {detail}
                        {footer}
                    </>
                )
            }
            icon={noticeIcon(feedback)}
            testId={testId}
            tone={noticeTone(feedback)}
        >
            {feedback.kind === "closed" ? "The session is closed." : feedback.title}
        </MortyAlert>
    );
}
