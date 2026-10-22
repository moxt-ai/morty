import { type ComponentProps, useCallback } from "react";

/**
 * An input that focuses and selects its whole value when it mounts. Used for
 * editors that appear on open (for example a title rename), replacing a mount
 * effect in the caller. The callback identity is stable for the input's
 * lifetime, so re-renders never re-run the focus.
 */
export function AutoSelectInput({
    selectOnAttach = true,
    ...props
}: { readonly selectOnAttach?: boolean } & ComponentProps<"input">) {
    const focus = useCallback(
        (node: HTMLInputElement | null): void => {
            node?.focus();
            if (node !== null && selectOnAttach) {
                node.select();
            }
        },
        [selectOnAttach],
    );
    return <input ref={focus} {...props} />;
}
