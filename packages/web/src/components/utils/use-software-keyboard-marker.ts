import { type RefCallback, useCallback } from "react";

const markerAttribute = "data-software-keyboard";
/** A visible height this much shorter than the tallest one seen at this width means a software keyboard is up. */
const keyboardHeightThresholdPx = 120;

type ClosedViewport = { readonly width: number; readonly height: number };

/**
 * The tallest visible height seen per window and width. It is shared across composer mounts and only grows, so
 * another field's keyboard, a remount, or a blur during the closing animation cannot lower it. A width change
 * (rotation) starts over.
 */
const closedViewports = new WeakMap<Window, ClosedViewport>();

/**
 * Attaches to the composer form and marks it `data-software-keyboard="open"` while a software keyboard covers
 * the bottom edge.
 *
 * iOS keeps reporting the full safe-area inset while the keyboard covers the home indicator, so the composer's
 * safe-area margin would float it above the keyboard. Neither a coarse pointer nor focus proves the keyboard is
 * visible, because a Bluetooth keyboard has both, so this compares the visible height with the tallest height seen
 * before. A host that never shrinks its viewport leaves the marker off and the safe-area margin in place. The marker
 * is a DOM attribute, so the layout flips without re-rendering the composer. Listeners are bound and released with
 * the form element.
 */
export function useSoftwareKeyboardMarker(): RefCallback<HTMLFormElement> {
    return useCallback((form) => {
        const view = form?.ownerDocument.defaultView;
        if (form === null || view === null || view === undefined) {
            return;
        }
        const visible = view.visualViewport;
        const sync = () => {
            const width = view.innerWidth;
            const height = visible?.height ?? view.innerHeight;
            const known = closedViewports.get(view);
            const closed =
                known?.width === width ? { width, height: Math.max(known.height, height) } : { width, height };
            closedViewports.set(view, closed);
            const active = form.ownerDocument.activeElement;
            const typing = active instanceof HTMLTextAreaElement && form.contains(active);
            if (typing && height < closed.height - keyboardHeightThresholdPx) {
                form.setAttribute(markerAttribute, "open");
            } else {
                form.removeAttribute(markerAttribute);
            }
        };
        const onFocusOut = () => form.removeAttribute(markerAttribute);
        form.addEventListener("focusin", sync);
        form.addEventListener("focusout", onFocusOut);
        view.addEventListener("resize", sync);
        visible?.addEventListener("resize", sync);
        sync();
        return () => {
            form.removeEventListener("focusin", sync);
            form.removeEventListener("focusout", onFocusOut);
            view.removeEventListener("resize", sync);
            visible?.removeEventListener("resize", sync);
            form.removeAttribute(markerAttribute);
        };
    }, []);
}
