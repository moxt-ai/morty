import { useLayoutEffect, useState } from "react";

export type ElementSize = { readonly height: number; readonly width: number };

/**
 * Measures an element's content box before paint and re-measures it whenever it
 * resizes. Callers own what the size means; the hook only observes layout.
 */
export function useElementSize<T extends HTMLElement>(): {
    readonly element: T | null;
    readonly observe: (element: T | null) => void;
    readonly size: ElementSize | null;
} {
    const [element, setElement] = useState<T | null>(null);
    const [size, setSize] = useState<ElementSize | null>(null);
    useLayoutEffect(() => {
        if (element === null) {
            return;
        }
        const measure = () => {
            setSize({ height: element.clientHeight, width: element.clientWidth });
        };
        measure();
        if (typeof ResizeObserver === "undefined") {
            return;
        }
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [element]);
    return { element, observe: setElement, size };
}
