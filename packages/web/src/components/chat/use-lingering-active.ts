import { useEffect, useState } from "react";

/**
 * Holds `active` true for `lingerMs` after it turns false. A disclosure that opens while the Agent streams
 * uses it so the closing follows the end of the stream by a beat instead of cutting the text off.
 * Content that is already finished when it mounts never lingers.
 */
export function useLingeringActive(active: boolean, lingerMs: number): boolean {
    const [lingering, setLingering] = useState(false);
    useEffect(() => {
        if (active) {
            setLingering(true);
            return;
        }
        if (!lingering) {
            return;
        }
        const timer = setTimeout(() => setLingering(false), lingerMs);
        return () => clearTimeout(timer);
    }, [active, lingering, lingerMs]);
    return active || lingering;
}
