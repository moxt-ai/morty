import { LoaderCircle } from "lucide-react";
import { dataTestId } from "../../data-testid.ts";
import { LinkButton } from "../ui/link-button.tsx";
import type { ConnectionFeedback } from "./execution-context.ts";

export function ConnectionNotice({
    feedback,
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
    readonly onRetryNow: () => void;
    readonly onReopen: () => void;
}) {
    if (feedback.kind === "hidden") {
        return null;
    }
    const failed = feedback.kind === "failed" || (feedback.kind === "closed" && feedback.reopen === "failed");
    // No text size here: the row already sets text-12, and passing a custom text-*
    // token through LinkButton's tailwind-merge would evict its text-primary color.
    const actionClassName = inline ? "min-h-5" : "min-h-11 sm:min-h-5";
    const retry =
        feedback.kind === "retrying" || feedback.kind === "failed" ? (
            <LinkButton className={actionClassName} onClick={onRetryNow}>
                Retry now
            </LinkButton>
        ) : null;
    const reopen =
        feedback.kind === "closed" ? (
            <LinkButton
                className={actionClassName}
                disabled={feedback.reopen === "reopening" || feedback.reopen === "offline"}
                onClick={onReopen}
            >
                {feedback.reopen === "reopening" ? "Reopening…" : "Reopen it"}
            </LinkButton>
        ) : null;
    const testId = feedback.kind === "closed" ? dataTestId.sessionClosedNotice : dataTestId.sessionReconnectNotice;

    // The waiting state reads as a quiet chip, not a card: title only, in a
    // button-like shape on the chat surface so it sits left-aligned with the
    // composer instead of spanning the pane.
    if (feedback.kind === "waiting" && !inline) {
        return (
            <div
                className="flex h-7 w-fit items-center gap-1 rounded-full bg-surface-elevated px-3 text-12 font-medium text-morty-text-2"
                data-testid={testId}
            >
                <LoaderCircle aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
                {feedback.title}
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
                {feedback.kind === "retrying" && feedback.remainingSeconds !== null && (
                    <span className="tabular-nums">Retrying in {feedback.remainingSeconds} s</span>
                )}
                {retry}
                {reopen}
            </div>
        );
    }

    return (
        // The host notice owns the surface and the live region: a failure reads
        // through the host's error tone instead of a nested red block here.
        // Plain string, not cn(): tailwind-merge reads the custom text-13 token as a
        // text color and would evict it in favor of text-muted-foreground.
        <div className={`min-w-0 w-full text-13${failed ? "" : " text-muted-foreground"}`} data-testid={testId}>
            {/* Headline stands alone; countdown and action sit with the detail line. */}
            <p className="font-medium">{feedback.kind === "closed" ? "The session is closed." : feedback.title}</p>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-12 font-normal text-muted-foreground">
                <span className="min-w-0">{feedback.description}</span>
                {feedback.kind === "retrying" && feedback.remainingSeconds !== null && (
                    <span className="tabular-nums">Retrying in {feedback.remainingSeconds} s</span>
                )}
                {retry}
                {reopen}
            </div>
        </div>
    );
}
