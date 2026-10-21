import { type ComponentPropsWithoutRef, type RefObject, useEffect, useLayoutEffect, useRef } from "react";

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
};

/**
 * Keeps a scroll container pinned to its latest content until the user moves
 * away from the bottom. It has no knowledge of the content or its workflow.
 */
export function FollowLatestScrollArea({
    container,
    followThreshold = 1,
    followRevision = null,
    onScroll,
    ...props
}: FollowLatestScrollAreaProps) {
    const following = useRef(true);

    // biome-ignore lint/correctness/useExhaustiveDependencies: followRevision is the deliberate re-arm trigger.
    useLayoutEffect(() => {
        following.current = true;
        const element = container.current;
        if (element !== null) {
            element.scrollTop = element.scrollHeight;
        }
    }, [container, followRevision]);
    useLayoutEffect(() => {
        const element = container.current;
        if (following.current && element !== null) {
            element.scrollTop = element.scrollHeight;
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
    }, [container]);

    return (
        <div
            {...props}
            ref={container}
            onScroll={(event) => {
                const element = event.currentTarget;
                following.current = element.scrollHeight - element.scrollTop - element.clientHeight < followThreshold;
                onScroll?.(event);
            }}
        />
    );
}
