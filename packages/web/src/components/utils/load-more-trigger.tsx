import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

const TOP_EDGE_PIXELS = 80;

/**
 * Requests an older page when a scroll container reaches its top edge, then
 * restores the visible scroll offset after the older content is prepended.
 *
 * This is intentionally free of any domain or workflow knowledge: callers pass
 * a scroll container, whether more content exists, whether a request is already
 * in flight, a monotonic revision that changes when content is prepended, and
 * the load callback.
 */
export function LoadMoreTrigger({
    container,
    hasMore,
    loading,
    onLoadMore,
    revision,
}: {
    readonly container: RefObject<HTMLElement | null>;
    readonly hasMore: boolean;
    readonly loading: boolean;
    readonly onLoadMore: (signal: AbortSignal) => Promise<void>;
    readonly revision: number;
}) {
    const anchor = useRef<{ readonly height: number; readonly top: number } | null>(null);
    const pending = useRef(false);
    const controller = useRef<AbortController | null>(null);

    useEffect(
        () => () => {
            controller.current?.abort();
        },
        [],
    );

    useEffect(() => {
        const element = container.current;
        if (element === null) {
            return;
        }
        const request = (): void => {
            if (pending.current || !hasMore || loading || element.scrollTop > TOP_EDGE_PIXELS) {
                return;
            }
            pending.current = true;
            anchor.current = { height: element.scrollHeight, top: element.scrollTop };
            const requestController = new AbortController();
            controller.current = requestController;
            void onLoadMore(requestController.signal)
                .catch(() => {
                    anchor.current = null;
                })
                .finally(() => {
                    pending.current = false;
                });
        };
        element.addEventListener("scroll", request, { passive: true });
        return () => element.removeEventListener("scroll", request);
    }, [container, hasMore, loading, onLoadMore]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: Restore the scroll offset after the prepended content commits.
    useLayoutEffect(() => {
        const element = container.current;
        const saved = anchor.current;
        if (element !== null && saved !== null) {
            element.scrollTop = saved.top + (element.scrollHeight - saved.height);
            anchor.current = null;
        }
    }, [container, revision]);

    return null;
}
