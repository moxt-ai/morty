import { type RefObject, useEffect } from "react";

const markerAttribute = "data-software-keyboard";
/** A visible height this much shorter than before the textarea took focus means a software keyboard is up. */
const keyboardHeightThresholdPx = 120;

/**
 * Marks the composer form with `data-software-keyboard="open"` while a software keyboard covers the bottom edge.
 *
 * iOS keeps reporting the full safe-area inset while the keyboard covers the home indicator, so the composer's
 * safe-area margin would float it above the keyboard. Neither a coarse pointer nor focus proves the keyboard is
 * visible, because a Bluetooth keyboard has both, so this compares the visible height with the height seen while
 * no textarea in the form had focus. A host that never shrinks its viewport leaves the marker off and the
 * safe-area margin in place. The marker is a DOM attribute, so the layout flips without re-rendering the composer.
 */
export function useSoftwareKeyboardMarker(form: RefObject<HTMLFormElement | null>): void {
    useEffect(() => {
        const element = form.current;
        if (element === null) {
            return;
        }
        const visible = window.visualViewport;
        const height = () => visible?.height ?? window.innerHeight;
        let unfocusedHeight = height();
        const sync = (focused: boolean) => {
            if (!focused) {
                unfocusedHeight = height();
                element.removeAttribute(markerAttribute);
            } else if (height() < unfocusedHeight - keyboardHeightThresholdPx) {
                element.setAttribute(markerAttribute, "open");
            } else {
                element.removeAttribute(markerAttribute);
            }
        };
        const textareaFocused = () => {
            const active = element.ownerDocument.activeElement;
            return active instanceof HTMLTextAreaElement && element.contains(active);
        };
        const onFocusIn = (event: FocusEvent) => sync(event.target instanceof HTMLTextAreaElement);
        const onFocusOut = () => sync(false);
        const onResize = () => sync(textareaFocused());
        element.addEventListener("focusin", onFocusIn);
        element.addEventListener("focusout", onFocusOut);
        window.addEventListener("resize", onResize);
        visible?.addEventListener("resize", onResize);
        return () => {
            element.removeEventListener("focusin", onFocusIn);
            element.removeEventListener("focusout", onFocusOut);
            window.removeEventListener("resize", onResize);
            visible?.removeEventListener("resize", onResize);
            element.removeAttribute(markerAttribute);
        };
    }, [form]);
}
