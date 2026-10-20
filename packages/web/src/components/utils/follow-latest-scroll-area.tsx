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

type FollowLatestScrollAreaProps = Omit<ComponentPropsWithoutRef<"div">, "ref"> & {
    readonly container: RefObject<HTMLDivElement | null>;
    readonly followThreshold?: number;
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
    followThreshold = 1,
    followRevision = null,
    showTopFade = false,
    topFadeClassName = "from-card/90",
    className,
    onScroll,
    ...props
}: FollowLatestScrollAreaProps) {
    const following = useRef(true);
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
        const element = container.current;
        if (element !== null) {
            element.scrollTop = element.scrollHeight;
            syncTopFade(element);
        }
    }, [container, followRevision]);
    useLayoutEffect(() => {
        const element = container.current;
        if (following.current && element !== null) {
            element.scrollTop = element.scrollHeight;
        }
        if (element !== null) {
            syncTopFade(element);
        }
    });

    useEffect(() => {
        const element = container.current;
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
    }, [container, syncTopFade]);

    const scrollArea = (
        <div
            {...props}
            className={className}
            ref={container}
            onScroll={(event) => {
                const element = event.currentTarget;
                following.current = element.scrollHeight - element.scrollTop - element.clientHeight < followThreshold;
                syncTopFade(element);
                onScroll?.(event);
            }}
        />
    );

    if (!showTopFade) {
        return scrollArea;
    }

    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            {scrollArea}
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
