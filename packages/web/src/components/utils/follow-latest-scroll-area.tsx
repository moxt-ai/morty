import { type ComponentPropsWithoutRef, type RefObject, useEffect, useLayoutEffect, useRef } from "react";

type FollowLatestScrollAreaProps = Omit<ComponentPropsWithoutRef<"div">, "ref"> & {
    readonly container: RefObject<HTMLDivElement | null>;
    readonly followThreshold?: number;
};

/**
 * Keeps a scroll container pinned to its latest content until the user moves
 * away from the bottom. It has no knowledge of the content or its workflow.
 */
export function FollowLatestScrollArea({
    container,
    followThreshold = 1,
    onScroll,
    ...props
}: FollowLatestScrollAreaProps) {
    const following = useRef(true);

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
        const observer = new MutationObserver(() => {
            if (following.current) {
                element.scrollTop = element.scrollHeight;
            }
        });
        observer.observe(element, { characterData: true, childList: true, subtree: true });
        return () => observer.disconnect();
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
