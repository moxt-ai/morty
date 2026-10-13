import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dataTestId } from "../../data-testid.ts";

function workingDuration(elapsedSeconds: number): string {
    if (elapsedSeconds < 60) {
        return `${elapsedSeconds.toString()}s`;
    }
    const minutes = Math.floor(elapsedSeconds / 60);
    return `${minutes.toString()}min ${(elapsedSeconds % 60).toString()}s`;
}

export function WorkingIndicator() {
    const startedAt = useRef(Date.now());
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    useEffect(() => {
        const update = () => setElapsedSeconds(Math.floor((Date.now() - startedAt.current) / 1000));
        const interval = window.setInterval(update, 1000);
        return () => window.clearInterval(interval);
    }, []);

    return (
        <span
            aria-label="Agent is working"
            className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums"
            data-testid={dataTestId.workingIndicator}
            role="status"
        >
            <span>Working for {workingDuration(elapsedSeconds)}</span>
            <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
                data-testid={dataTestId.workingSpinner}
            />
        </span>
    );
}
