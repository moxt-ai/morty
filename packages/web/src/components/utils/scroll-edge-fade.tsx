import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const EDGE_THRESHOLD_PX = 4;

type ScrollEdge = "top" | "bottom";

type ScrollEdgeFadeProps = {
    /** Element that actually scrolls. Use `ol` or `ul` when the list itself is the scrollport. */
    readonly scrollElement?: "div" | "ol" | "ul";
    readonly children: ReactNode;
    /** Tailwind `from-*` class matching the surface behind the clipped content. */
    readonly fadeFromClassName: string;
    /** Layout classes for the non-scrolling frame that holds the fades. */
    readonly frameClassName?: string;
    /**
     * Overrides the top fade placement. Session lists pass this so a sticky
     * group label stays solid while content below it fades.
     */
    readonly topFadeClassName?: string;
    readonly className?: string;
    readonly id?: string;
    readonly "aria-label"?: string;
};

type ClippedEdges = Readonly<Record<ScrollEdge, boolean>>;

const hiddenEdges: ClippedEdges = { top: false, bottom: false };

function clippedEdges(element: HTMLElement): ClippedEdges {
    return {
        top: element.scrollTop > EDGE_THRESHOLD_PX,
        bottom: element.scrollHeight - element.scrollTop - element.clientHeight > EDGE_THRESHOLD_PX,
    };
}

/**
 * Paints a gradient on each vertical edge that still has clipped content, and
 * hides that gradient once the edge is scrolled fully into view.
 */
export function ScrollEdgeFade({
    scrollElement = "div",
    children,
    fadeFromClassName,
    frameClassName,
    topFadeClassName,
    className,
    id,
    "aria-label": ariaLabel,
}: ScrollEdgeFadeProps) {
    const scrollRef = useRef<HTMLElement | null>(null);
    const [edges, setEdges] = useState<ClippedEdges>(hiddenEdges);

    const syncEdges = useCallback(() => {
        const element = scrollRef.current;
        if (element === null) {
            return;
        }
        const next = clippedEdges(element);
        setEdges((current) => (current.top === next.top && current.bottom === next.bottom ? current : next));
    }, []);

    useLayoutEffect(() => {
        syncEdges();
    });

    useEffect(() => {
        const element = scrollRef.current;
        if (element === null) {
            return;
        }
        const resizes = new ResizeObserver(syncEdges);
        resizes.observe(element);
        for (const child of element.children) {
            if (child instanceof HTMLElement) {
                resizes.observe(child);
            }
        }
        const mutations = new MutationObserver(() => {
            syncEdges();
            for (const child of element.children) {
                if (child instanceof HTMLElement) {
                    resizes.observe(child);
                }
            }
        });
        mutations.observe(element, { characterData: true, childList: true, subtree: true });
        return () => {
            mutations.disconnect();
            resizes.disconnect();
        };
    }, [syncEdges]);

    const assignScrollElement = (node: HTMLElement | null) => {
        scrollRef.current = node;
    };
    const surface = {
        ref: assignScrollElement,
        id,
        "aria-label": ariaLabel,
        className,
        onScroll: () => {
            syncEdges();
        },
    };

    return (
        <div className={cn("relative min-h-0", frameClassName)}>
            {scrollElement === "ol" ? (
                <ol {...surface}>{children}</ol>
            ) : scrollElement === "ul" ? (
                <ul {...surface}>{children}</ul>
            ) : (
                <div {...surface}>{children}</div>
            )}
            <EdgeFade
                className={cn("inset-x-0 top-0 h-8 bg-gradient-to-b", fadeFromClassName, topFadeClassName)}
                visible={edges.top}
            />
            <EdgeFade
                className={cn("inset-x-0 bottom-0 h-8 bg-gradient-to-t", fadeFromClassName)}
                visible={edges.bottom}
            />
        </div>
    );
}

function EdgeFade({ className, visible }: { readonly className: string; readonly visible: boolean }) {
    return (
        <div
            aria-hidden="true"
            className={cn(
                "pointer-events-none absolute z-10 to-transparent transition-opacity duration-150 motion-reduce:transition-none",
                className,
                visible ? "opacity-100" : "opacity-0",
            )}
        />
    );
}
