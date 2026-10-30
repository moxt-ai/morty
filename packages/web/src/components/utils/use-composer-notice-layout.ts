import { type RefObject, useLayoutEffect } from "react";

/**
 * Positions the composer notice above the form, keeping its 8px gap. While the
 * notice overlaps the message log it sinks the message tail below the log edge,
 * so reply text fills the notice's frosted blur instead of empty reserved space.
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
        const watch = (node: Element | null) => {
            if (node !== null) {
                resizes.observe(node);
            }
        };
        const sync = () => {
            const queue = pane.querySelector('[aria-label="Queued messages"]');
            watch(queue);
            const formTop = form.getBoundingClientRect().top;
            const queueTop = queue instanceof HTMLElement ? queue.getBoundingClientRect().top : formTop;
            const aboveForm = Math.max(0, Math.round(formTop - queueTop));
            const log = pane.querySelector('[role="log"]');
            const atBottom = log instanceof HTMLElement && log.scrollHeight - log.scrollTop - log.clientHeight < 80;
            // The gap above the composer is constant, so the notice rect is stable
            // to measure against the log edge.
            element.style.bottom = `calc(100% + ${aboveForm + gapPx}px)`;
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
        watch(element);
        watch(form);
        const mutations = new MutationObserver(sync);
        mutations.observe(pane, { childList: true });
        sync();
        return () => {
            resizes.disconnect();
            mutations.disconnect();
            element.style.removeProperty("bottom");
            pane.style.removeProperty("--composer-notice-tuck");
            pane.style.removeProperty("--composer-overlay-block");
        };
    }, [enabled]);
}
