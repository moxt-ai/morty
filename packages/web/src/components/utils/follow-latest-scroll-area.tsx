import {
    type ComponentPropsWithoutRef,
    type RefObject,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { cn } from "@/lib/utils";
import { useLoadMoreOnScroll } from "./load-more-trigger.tsx";

const scrollAnchorTriggerAttribute = "data-scroll-anchor-trigger";
const scrollAnchorTriggerSelector = `[${scrollAnchorTriggerAttribute}]`;

/**
 * Marks a control whose click resizes the content around it. While the content moves, the area holds the
 * control where the reader clicked it instead of following the latest content or letting the viewport jump.
 */
export const scrollAnchorTriggerProps = { [scrollAnchorTriggerAttribute]: "" } as const;

// A click starts a short hold. It lasts at least as long as the 200 ms disclosure slide, then ends once the
// control has stayed put for a few frames; the cap keeps a control that never settles from holding forever.
const anchorMinimumFrames = 15;
const anchorSettledFrames = 4;
const anchorMaximumFrames = 90;
const anchorDriftEpsilonPx = 0.5;
const anchorScrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

type FollowLatestScrollAreaProps = Omit<ComponentPropsWithoutRef<"div">, "ref"> & {
    /** Callers that need the element pass their ref; omitted, the area owns it. */
    readonly container?: RefObject<HTMLDivElement | null>;
    /**
     * Requests an older page when the top edge is reached. Providing it wires
     * top-edge pagination into the area so callers never hold scroll refs.
     */
    readonly loadOlder?: {
        readonly hasMore: boolean;
        readonly loading: boolean;
        readonly onLoadMore: (signal: AbortSignal) => Promise<void>;
        readonly revision: number;
    };
    readonly followThreshold?: number | undefined;
    /**
     * Re-arms following whenever this value changes: the container scrolls
     * back to its latest content even if the user had scrolled away. Purely a
     * scroll concern; callers decide what a new value means. `null` never
     * re-arms.
     */
    readonly followRevision: number | null;
    readonly showTopFade?: boolean;
    /** `from-<surface> to-<surface>/0` for the opaque surface behind this scroller. */
    readonly topFadeClassName?: string;
};

/**
 * Keeps a scroll container pinned to its latest content until the user moves
 * away from the bottom. It has no knowledge of the content or its workflow.
 */
export function FollowLatestScrollArea({
    container,
    loadOlder,
    followThreshold = 1,
    followRevision = null,
    showTopFade = false,
    topFadeClassName = "from-card to-card/0",
    className,
    onScroll,
    ...props
}: FollowLatestScrollAreaProps) {
    const owned = useRef<HTMLDivElement | null>(null);
    const scrollArea = container ?? owned;
    const following = useRef(true);
    const holdingAnchor = useRef(false);
    const lastTop = useRef(0);
    const pagination = useLoadMoreOnScroll({
        container: scrollArea,
        hasMore: loadOlder?.hasMore ?? false,
        loading: loadOlder?.loading ?? false,
        onLoadMore: loadOlder?.onLoadMore ?? (async () => {}),
        revision: loadOlder?.revision ?? 0,
    });
    const [topFadeVisible, setTopFadeVisible] = useState(false);
    const settleFollowing = useCallback(
        (element: HTMLDivElement) => {
            following.current = element.scrollHeight - element.scrollTop - element.clientHeight < followThreshold;
        },
        [followThreshold],
    );

    const syncTopFade = useCallback(
        (element: HTMLDivElement) => {
            if (!showTopFade) {
                return;
            }
            setTopFadeVisible(element.scrollTop > 4);
        },
        [showTopFade],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: followRevision is the deliberate re-arm trigger.
    useLayoutEffect(() => {
        following.current = true;
        const element = scrollArea.current;
        if (element !== null) {
            element.scrollTop = element.scrollHeight;
            syncTopFade(element);
        }
    }, [container, followRevision]);
    useLayoutEffect(() => {
        const element = scrollArea.current;
        if (following.current && element !== null) {
            element.scrollTop = element.scrollHeight;
        }
        if (element !== null) {
            syncTopFade(element);
        }
    });

    useEffect(() => {
        const element = scrollArea.current;
        if (element === null) {
            return;
        }
        const keepLatestVisible = () => {
            if (following.current) {
                element.scrollTop = element.scrollHeight;
            }
            syncTopFade(element);
        };
        // Content changes (streaming, replacing branches) and pure layout
        // changes (window resizing, images loading, reflowed text) both move
        // the latest content; watch both so following survives each.
        const mutations = new MutationObserver(keepLatestVisible);
        mutations.observe(element, { characterData: true, childList: true, subtree: true });
        const resizes = new ResizeObserver(keepLatestVisible);
        resizes.observe(element);
        for (const child of element.children) {
            resizes.observe(child);
        }
        return () => {
            mutations.disconnect();
            resizes.disconnect();
        };
    }, [syncTopFade, scrollArea.current]);

    useEffect(() => {
        const element = scrollArea.current;
        if (element === null) {
            return;
        }
        let releaseHold: (() => void) | null = null;
        const hold = (trigger: HTMLElement) => {
            releaseHold?.();
            const offsetOf = () => trigger.getBoundingClientRect().top - element.getBoundingClientRect().top;
            const anchoredOffset = offsetOf();
            let frames = 0;
            let quietFrames = 0;
            let frame = 0;
            const release = () => {
                cancelAnimationFrame(frame);
                releaseHold = null;
                holdingAnchor.current = false;
            };
            const step = () => {
                frames += 1;
                const drift = offsetOf() - anchoredOffset;
                if (Math.abs(drift) > anchorDriftEpsilonPx) {
                    element.scrollTop += drift;
                    quietFrames = 0;
                } else {
                    quietFrames += 1;
                }
                const settled = frames >= anchorMinimumFrames && quietFrames >= anchorSettledFrames;
                if (!trigger.isConnected || settled || frames >= anchorMaximumFrames) {
                    release();
                    settleFollowing(element);
                    return;
                }
                frame = requestAnimationFrame(step);
            };
            releaseHold = release;
            holdingAnchor.current = true;
            frame = requestAnimationFrame(step);
        };
        // The reader chose to look at this spot, so the latest content stops pulling the view away from it.
        const onClick = (event: MouseEvent) => {
            const trigger = event.target instanceof Element ? event.target.closest(scrollAnchorTriggerSelector) : null;
            if (!(trigger instanceof HTMLElement) || !element.contains(trigger)) {
                return;
            }
            following.current = false;
            hold(trigger);
        };
        // Moving the view by hand ends the hold at once.
        const cancelHold = () => releaseHold?.();
        const onKeyDown = (event: KeyboardEvent) => {
            if (anchorScrollKeys.has(event.key)) {
                cancelHold();
            }
        };
        const onPointerDown = (event: PointerEvent) => {
            // A press on the area itself rather than its content is a press on the scrollbar.
            if (event.target === element) {
                cancelHold();
            }
        };
        element.addEventListener("click", onClick, { capture: true });
        element.addEventListener("wheel", cancelHold, { passive: true });
        element.addEventListener("touchstart", cancelHold, { passive: true });
        element.addEventListener("keydown", onKeyDown);
        element.addEventListener("pointerdown", onPointerDown, { passive: true });
        return () => {
            cancelHold();
            element.removeEventListener("click", onClick, { capture: true });
            element.removeEventListener("wheel", cancelHold);
            element.removeEventListener("touchstart", cancelHold);
            element.removeEventListener("keydown", onKeyDown);
            element.removeEventListener("pointerdown", onPointerDown);
        };
    }, [settleFollowing, scrollArea.current]);

    const area = (
        <div
            {...props}
            className={className}
            ref={scrollArea}
            onScroll={(event) => {
                const element = event.currentTarget;
                const top = element.scrollTop;
                const distanceFromLatest = element.scrollHeight - top - element.clientHeight;
                // Any upward move away from the bottom is the user leaving the latest content, even when the
                // whole overflow fits inside the follow threshold; without this, a short conversation pins
                // every user scroll back to the bottom. Programmatic pins and shrinking content land at the
                // bottom (distance 0), so they keep following.
                // While a click holds its control in place, the scrolling is the hold's own; it hands following back
                // when it ends.
                if (!holdingAnchor.current) {
                    if (top < lastTop.current && distanceFromLatest > 0) {
                        following.current = false;
                    } else if (distanceFromLatest < followThreshold) {
                        following.current = true;
                    }
                }
                lastTop.current = top;
                syncTopFade(element);
                if (loadOlder !== undefined) {
                    pagination.checkScrollEdge(element, false);
                }
                onScroll?.(event);
            }}
        />
    );

    if (!showTopFade) {
        return area;
    }

    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            {area}
            <div
                aria-hidden="true"
                className={cn(
                    "pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b transition-opacity duration-150 motion-reduce:transition-none",
                    topFadeClassName,
                    topFadeVisible ? "opacity-100" : "opacity-0",
                )}
            />
        </div>
    );
}
