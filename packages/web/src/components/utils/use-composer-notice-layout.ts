import { type RefObject, useLayoutEffect } from "react";

/** Positions the composer notice above the form and reserves log padding for its overlap. */
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
        const tuckPx = 48;
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
            element.style.bottom = `calc(100% + ${aboveForm + gapPx}px)`;
            const log = pane.querySelector('[role="log"]');
            const atBottom = log instanceof HTMLElement && log.scrollHeight - log.scrollTop - log.clientHeight < 80;
            const applied = Number.parseFloat(pane.style.getPropertyValue("--composer-overlay-block")) || 0;
            const overlap =
                log instanceof HTMLElement
                    ? Math.max(0, log.getBoundingClientRect().bottom - element.getBoundingClientRect().top)
                    : element.offsetHeight + gapPx;
            const basePad =
                log instanceof HTMLElement ? Number.parseFloat(getComputedStyle(log).paddingBottom) - applied : 0;
            const overlay = Math.max(0, Math.round(overlap - basePad - tuckPx));
            pane.style.setProperty("--composer-overlay-block", `${overlay}px`);
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
            pane.style.removeProperty("--composer-overlay-block");
        };
    }, [enabled]);
}
