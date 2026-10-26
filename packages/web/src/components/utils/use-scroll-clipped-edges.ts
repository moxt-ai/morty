import { type RefObject, useCallback, useEffect, useLayoutEffect, useState } from "react";

type ClippedEdges = {
    readonly bottom: boolean;
    readonly top: boolean;
};

export function useScrollClippedEdges(contentRef: RefObject<HTMLElement | null>, thresholdPx: number): ClippedEdges {
    const [clipped, setClipped] = useState<ClippedEdges>({ bottom: false, top: false });
    const syncClipped = useCallback(() => {
        const element = contentRef.current;
        if (element === null) {
            return;
        }
        const next = {
            bottom: element.scrollHeight - element.scrollTop - element.clientHeight > thresholdPx,
            top: element.scrollTop > thresholdPx,
        };
        setClipped((current) => (current.top === next.top && current.bottom === next.bottom ? current : next));
    }, [contentRef, thresholdPx]);
    // Child scroll-to-latest runs first; this layout pass reads that position.
    useLayoutEffect(() => {
        syncClipped();
    });
    useEffect(() => {
        const element = contentRef.current;
        if (element === null) {
            return;
        }
        element.addEventListener("scroll", syncClipped, { passive: true });
        const resizes = new ResizeObserver(syncClipped);
        resizes.observe(element);
        for (const child of element.children) {
            resizes.observe(child);
        }
        return () => {
            element.removeEventListener("scroll", syncClipped);
            resizes.disconnect();
        };
    }, [contentRef, syncClipped]);
    return clipped;
}
