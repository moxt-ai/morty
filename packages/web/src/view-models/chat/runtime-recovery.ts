/**
 * How the page saw a Runtime configuration: read directly by a load, or delivered by a configuration watch. A watch
 * snapshot follows a change when the Runtime changed since the previous one, or may have while the bridge was down.
 */
export type RuntimeObservation = { readonly kind: "read" } | { readonly kind: "watch"; readonly afterChange: boolean };

/**
 * Decides when the workspace re-reads what it could not read because the Runtime was unreachable. A watch snapshot
 * that shows the Runtime online retries it, the way Reconnect would. A snapshot that follows no change retries only
 * once until the Runtime is seen offline or nothing is left to recover, so a Runtime reported online that still cannot
 * be reached waits for its next change instead of being retried in a loop.
 */
export function createRuntimeRecovery() {
    let retryWithoutChange: "available" | "used" = "available";
    return {
        /** Adopts an observation, given whether anything is waiting for the Runtime; true when it should be retried now. */
        observe: (online: boolean, observation: RuntimeObservation, waiting: boolean): boolean => {
            if (!online) {
                // Once the page has seen the Runtime offline, its next online report is a return.
                retryWithoutChange = "available";
                return false;
            }
            if (observation.kind === "read") {
                return false;
            }
            if (!waiting) {
                retryWithoutChange = "available";
                return false;
            }
            if (!observation.afterChange && retryWithoutChange === "used") {
                return false;
            }
            retryWithoutChange = "used";
            return true;
        },
    };
}
