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
    topFadeClassName = "from-card",
    className,
    onScroll,
    ...props
}: FollowLatestScrollAreaProps) {
    const owned = useRef<HTMLDivElement | null>(null);
    const scrollArea = container ?? owned;
    const following = useRef(true);
    const pagination = useLoadMoreOnScroll({
        container: scrollArea,
        hasMore: loadOlder?.hasMore ?? false,
        loading: loadOlder?.loading ?? false,
        onLoadMore: loadOlder?.onLoadMore ?? (async () => {}),
        revision: loadOlder?.revision ?? 0,
    });
    const [topFadeVisible, setTopFadeVisible] = useState(false);

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

    const area = (
        <div
            {...props}
            className={className}
            ref={scrollArea}
            onScroll={(event) => {
                const element = event.currentTarget;
                following.current = element.scrollHeight - element.scrollTop - element.clientHeight < followThreshold;
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
                    "pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b to-transparent transition-opacity duration-150 motion-reduce:transition-none",
                    topFadeClassName,
                    topFadeVisible ? "opacity-100" : "opacity-0",
                )}
            />
        </div>
    );
}
