import { dataTestId } from "@/data-testid";

/** Right-hand status on the composer while the live session stream is reconnecting. */
export function SessionReconnectingStatus() {
    return (
        <div className="shrink-0 text-muted-foreground" data-testid={dataTestId.sessionReconnectNotice}>
            <p role="status">
                {"Mobius is reconnecting"}
                <span
                    aria-hidden="true"
                    className="inline-block animate-reconnect-ellipsis whitespace-nowrap motion-reduce:animate-none"
                >
                    ...
                </span>
            </p>
        </div>
    );
}
