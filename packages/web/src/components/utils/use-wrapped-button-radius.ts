import { type RefObject, useLayoutEffect } from "react";

/**
 * Gives wrapped buttons inside a row the block radius. A single-line button stays
 * a pill; once its copy wraps past the one 32px line (two lines or more) the button
 * reads as a block and takes the 16px radius (`rounded-md` on this repo's scale)
 * instead of the 20px pill. The two radius classes swap exclusively because
 * `rounded-md` sorts before `rounded-lg` and would otherwise lose the cascade.
 */
export function useWrappedButtonRadius(rowRef: RefObject<HTMLDivElement | null>): void {
    useLayoutEffect(() => {
        const row = rowRef.current;
        if (row === null) {
            return;
        }
        const sync = () => {
            for (const button of row.querySelectorAll("button")) {
                const wrapped = button.getBoundingClientRect().height > 40;
                button.classList.toggle("rounded-md", wrapped);
                button.classList.toggle("rounded-lg", !wrapped);
            }
        };
        const resizes = new ResizeObserver(sync);
        resizes.observe(row);
        sync();
        return () => resizes.disconnect();
    });
}
