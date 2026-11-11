import { type RefObject, useLayoutEffect } from "react";

/**
 * Floats the composer notice over the message log, keeping its 8px gap to the
 * form. The notice's overlap with the log wrapper is published as
 * `--composer-overlay-block`: the log's bottom margin rides it, so the log's
 * visible height shrinks by exactly the stacked notice and no scroll position
 * ever passes under the frost, and the jump-to-latest control rides it to stay
 * just above the notice. The hook also caps the notice to the room above the
 * form so even a fully squeezed log cannot push it past the pane's clipped top
 * edge.
 *
 * Only the overlay placement needs this. When queue or interaction cards stand
 * between the log and the composer, the notice renders in flow instead and the
 * pane's flex column allocates its height directly — nothing to measure.
 */
export function useComposerNoticeLayout(noticeRef: RefObject<HTMLDivElement | null>, enabled: boolean): void {
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-bind layout when the notice mounts or unmounts.
    useLayoutEffect(() => {
        if (!enabled) {
            return;
        }
        const element = noticeRef.current;
        const pane = element?.closest("section");
        const form = element?.parentElement;
        if (element === null || !(pane instanceof HTMLElement) || !(form instanceof HTMLElement)) {
            return;
        }
        const gapPx = 8;
        const resizes = new ResizeObserver(() => {
            sync();
        });
        const sync = () => {
            const log = pane.querySelector('[role="log"]');
            // ScrollArea puts the log role on its viewport; the stable anchor is outside its root.
            const scrollFrame = log?.closest('[data-slot="scroll-area"]') ?? log;
            // The pane clips its overflow, so the room between the pane top and
            // the form is all the floating notice can ever show; anything taller
            // scrolls inside its own slot instead of losing its actions at the edge.
            const room = Math.floor(form.getBoundingClientRect().top - pane.getBoundingClientRect().top) - gapPx;
            if (room > 0 && element.scrollHeight > room) {
                element.style.maxHeight = `${room}px`;
                element.style.overflowY = "auto";
            } else {
                element.style.removeProperty("max-height");
                element.style.removeProperty("overflow-y");
            }
            // The jump-to-latest control and the log's bottom margin ride this
            // height. Measure from the scroll wrapper's bottom edge — their
            // anchor — because the log's negative bottom margin extends its rect
            // below that anchor and would inflate the gap.
            const noticeTop = element.getBoundingClientRect().top;
            const anchorBottom =
                scrollFrame instanceof HTMLElement && scrollFrame.parentElement !== null
                    ? scrollFrame.parentElement.getBoundingClientRect().bottom
                    : noticeTop;
            pane.style.setProperty("--composer-overlay-block", `${Math.max(0, anchorBottom - noticeTop)}px`);
        };
        resizes.observe(element);
        resizes.observe(form);
        sync();
        return () => {
            resizes.disconnect();
            element.style.removeProperty("max-height");
            element.style.removeProperty("overflow-y");
            pane.style.removeProperty("--composer-overlay-block");
        };
    }, [enabled]);
}
