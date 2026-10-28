import { LoaderCircle } from "lucide-react";
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

export function WorkingIndicator({
    startedAt,
    compact = false,
}: {
    readonly startedAt: number;
    readonly compact?: boolean;
}) {
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
            aria-live={compact ? "off" : "polite"}
            className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums"
            data-testid={dataTestId.workingIndicator}
            role="status"
        >
            <span>{compact ? workingDuration(elapsedSeconds) : `Working for ${workingDuration(elapsedSeconds)}`}</span>
            {!compact && (
                <LoaderCircle
                    aria-hidden="true"
                    className="size-4 animate-spin motion-reduce:animate-none"
                    data-testid={dataTestId.workingSpinner}
                />
            )}
        </span>
    );
}
