import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import { LinkButton } from "../ui/link-button.tsx";
import type { ConnectionFeedback } from "./execution-context.ts";

export function ConnectionNotice({
    feedback,
    onRetryNow,
    onReopen,
}: {
    readonly feedback: ConnectionFeedback;
    readonly onRetryNow: () => void;
    readonly onReopen: () => void;
}) {
    if (feedback.kind === "hidden") {
        return null;
    }
    const failed = feedback.kind === "failed" || (feedback.kind === "closed" && feedback.reopen === "failed");
    return (
        <div
            data-testid={
                feedback.kind === "closed" ? dataTestId.sessionClosedNotice : dataTestId.sessionReconnectNotice
            }
            className={cn(
                "min-w-0 w-full text-sm",
                failed ? "rounded-xl bg-destructive/5 px-3 py-2" : "text-muted-foreground",
            )}
        >
            <div role={failed ? "alert" : "status"} aria-live={failed ? "assertive" : "polite"} aria-atomic="true">
                <p className={cn("font-medium", failed && "text-destructive")}>
                    {feedback.kind === "closed" ? "The session is closed." : feedback.title}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{feedback.description}</p>
            </div>
            {feedback.kind === "retrying" && feedback.remainingSeconds !== null && (
                <span className="mr-2 text-xs tabular-nums">Retrying in {feedback.remainingSeconds} s</span>
            )}
            {(feedback.kind === "retrying" || feedback.kind === "failed") && (
                <LinkButton className="min-h-11" onClick={onRetryNow}>
                    Retry now
                </LinkButton>
            )}
            {feedback.kind === "closed" && (
                <LinkButton
                    className="min-h-11"
                    disabled={feedback.reopen === "reopening" || feedback.reopen === "offline"}
                    onClick={onReopen}
                >
                    {feedback.reopen === "reopening" ? "Reopening…" : "Reopen it"}
                </LinkButton>
            )}
        </div>
    );
}
