import { useEffect, useState } from "react";
import { dataTestId } from "../../data-testid.ts";

function workingDuration(elapsedSeconds: number): string {
    if (elapsedSeconds < 60) {
        return `${elapsedSeconds.toString()}s`;
    }
    const minutes = Math.floor(elapsedSeconds / 60);
    return `${minutes.toString()}min ${(elapsedSeconds % 60).toString()}s`;
}

function elapsedSecondsSince(startedAt: number): number {
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

/**
 * The running turn's work and how long it has run. `owner` names the client that owns the native session when the
 * turn runs there, which alone can stop it.
 */
export function WorkingIndicator({ owner, startedAt }: { readonly owner: string | null; readonly startedAt: number }) {
    const [elapsedSeconds, setElapsedSeconds] = useState(() => elapsedSecondsSince(startedAt));

    useEffect(() => {
        const update = () => setElapsedSeconds(elapsedSecondsSince(startedAt));
        update();
        const interval = window.setInterval(update, 1000);
        return () => window.clearInterval(interval);
    }, [startedAt]);

    return (
        <span
            aria-label="Agent is working"
            className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums"
            data-testid={dataTestId.workingIndicator}
            role="status"
        >
            <span className="animate-loading-text-shimmer bg-[linear-gradient(90deg,#8a8f98_0%,#8a8f98_35%,#fafafb_50%,#8a8f98_65%,#8a8f98_100%)] bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-muted-foreground">
                Working for {workingDuration(elapsedSeconds)}
                {owner === null ? null : ` in ${owner}`}
            </span>
            {owner === null ? null : <span>Only {owner} can stop it.</span>}
        </span>
    );
}

/** A message the native session's owner holds in its queue, which only that owner can resume. */
export function OwnerQueueNotice({ owner }: { readonly owner: string }) {
    return (
        <span className="text-xs text-muted-foreground" data-testid={dataTestId.workingIndicator} role="status">
            Queued in {owner}. If {owner} paused its queue, choose Continue there.
        </span>
    );
}
