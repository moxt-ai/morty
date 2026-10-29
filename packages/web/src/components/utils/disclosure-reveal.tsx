import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";

export interface DisclosureRevealState {
    /** Whether the content is mounted: while open, and until the closing animation has finished. */
    readonly present: boolean;
    readonly open: boolean;
    readonly panel: RefObject<HTMLDivElement | null>;
}

/**
 * Keeps a disclosure's content mounted while it slides shut. `open` is the logical state; `present` stays true
 * until the closing animation ends, or at once when nothing is animating (reduced motion, no animation engine).
 */
export function useDisclosureReveal(open: boolean): DisclosureRevealState {
    const [mounted, setMounted] = useState(open);
    const panel = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
        if (open) {
            setMounted(true);
            return;
        }
        const animations = panel.current?.getAnimations() ?? [];
        if (animations.length === 0) {
            setMounted(false);
            return;
        }
        let cancelled = false;
        void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
            if (!cancelled) {
                setMounted(false);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [open]);
    return { open, panel, present: open || mounted };
}

/**
 * Slides its content open from zero height and shut back to zero, clipping the overflow while it moves.
 * Only the height moves; the content does not fade. Spacing that should not pop in at zero height belongs on
 * the content, not on this panel.
 */
export function DisclosureReveal({
    children,
    id,
    reveal,
}: {
    readonly children: ReactNode;
    readonly id?: string | undefined;
    readonly reveal: DisclosureRevealState;
}) {
    return (
        <div
            className="grid data-[state=closed]:animate-disclosure-reveal-close data-[state=closed]:grid-rows-[0fr] data-[state=open]:animate-disclosure-reveal-open data-[state=open]:grid-rows-[1fr] motion-reduce:animate-none"
            data-state={reveal.open ? "open" : "closed"}
            id={id}
            ref={reveal.panel}
        >
            <div className="min-h-0 min-w-0 overflow-hidden">{children}</div>
        </div>
    );
}
