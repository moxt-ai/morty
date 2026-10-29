import { type RefCallback, type RefObject, useCallback } from "react";

// The draft and its new Session render different composer instances in the same workspace.
// Keep only DOM focus and selection across that replacement, scoped to the owning workspace.
const composerFocus = new WeakMap<object, { readonly start: number; readonly end: number }>();

export function useComposerFocus(
    textarea: RefObject<HTMLTextAreaElement | null>,
    focusScope?: object,
): RefCallback<HTMLTextAreaElement> {
    return useCallback(
        (element) => {
            textarea.current = element;
            if (element === null) {
                return;
            }
            if (focusScope !== undefined) {
                const selection = composerFocus.get(focusScope);
                composerFocus.delete(focusScope);
                if (selection !== undefined && element.ownerDocument.activeElement === element.ownerDocument.body) {
                    element.focus({ preventScroll: true });
                    element.setSelectionRange(selection.start, selection.end);
                }
            }
            return () => {
                if (focusScope !== undefined && element.ownerDocument.activeElement === element) {
                    composerFocus.set(focusScope, { start: element.selectionStart, end: element.selectionEnd });
                }
                textarea.current = null;
            };
        },
        [focusScope, textarea],
    );
}
