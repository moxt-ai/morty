import { type RefObject, useLayoutEffect } from "react";

/**
 * Floats the composer notice over the message log, keeping its 8px gap to the
 * form. While the notice overlaps the log it sinks the message tail below the
 * log edge, so reply text fills the notice's frosted blur instead of empty
 * reserved space, and it caps the notice to the room above the form so even a
 * fully squeezed log cannot push it past the pane's clipped top edge.
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
        /** Reply tail chrome (trailing padding plus copy row) sunk below the log edge. */
        const tuckPx = 60;
        const resizes = new ResizeObserver(() => {
            sync();
        });
        const sync = () => {
            const log = pane.querySelector('[role="log"]');
            const atBottom = log instanceof HTMLElement && log.scrollHeight - log.scrollTop - log.clientHeight < 80;
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
            // The gap above the composer is constant, so the notice rect is stable
            // to measure against the log edge.
            const overlap =
                log instanceof HTMLElement
                    ? Math.max(0, log.getBoundingClientRect().bottom - element.getBoundingClientRect().top)
                    : 0;
            // The jump-to-latest control rides this height so the gap above the notice
            // equals the gap it keeps to the composer below. Measure from the scroll
            // wrapper's bottom edge — the control's anchor — because the log's negative
            // bottom margin extends its rect below that anchor and would inflate the gap.
            const noticeTop = element.getBoundingClientRect().top;
            const anchorBottom =
                log instanceof HTMLElement && log.parentElement !== null
                    ? log.parentElement.getBoundingClientRect().bottom
                    : noticeTop;
            pane.style.setProperty("--composer-overlay-block", `${Math.max(0, anchorBottom - noticeTop)}px`);
            const tucked = overlap > gapPx;
            if (tucked && log instanceof HTMLElement) {
                const basePad = Number.parseFloat(getComputedStyle(log).paddingBottom) || 0;
                pane.style.setProperty("--composer-notice-tuck", `${-(basePad + tuckPx)}px`);
            } else {
                pane.style.removeProperty("--composer-notice-tuck");
            }
            if (atBottom && log instanceof HTMLElement) {
                log.scrollTop = log.scrollHeight;
            }
        };
        resizes.observe(element);
        resizes.observe(form);
        sync();
        return () => {
            resizes.disconnect();
            element.style.removeProperty("max-height");
            element.style.removeProperty("overflow-y");
            pane.style.removeProperty("--composer-notice-tuck");
            pane.style.removeProperty("--composer-overlay-block");
        };
    }, [enabled]);
}
