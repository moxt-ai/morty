import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * Reports whether a container has painted a `<section>`.
 * Runs after every render because the section can appear from a child update
 * without the container ref changing.
 */
export function useContainsRenderedSection(container: RefObject<HTMLElement | null>): boolean {
    const [ready, setReady] = useState(false);
    useLayoutEffect(() => {
        const hasSection = container.current?.querySelector("section") != null;
        setReady((current) => (current === hasSection ? current : hasSection));
    });
    return ready;
}
