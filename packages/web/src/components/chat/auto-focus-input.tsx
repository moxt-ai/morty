import { type KeyboardEvent, useEffect, useRef } from "react";
import { cn } from "../../lib/utils.ts";

/**
 * A text input that focuses and selects itself whenever it (re)mounts.
 * Ownership of the element stays here; callers pass value and handlers.
 * Recorded effect exception: the effect only drives this element's own
 * focus/selection — DOM-ephemeral state, no asynchronous workflow.
 */
export function AutoFocusInput({
    selectOnFocus = true,
    onKeyDown,
    ...props
}: {
    readonly selectOnFocus?: boolean;
    readonly onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
} & React.ComponentPropsWithoutRef<"input">) {
    const input = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        if (selectOnFocus) {
            input.current?.select();
        }
        input.current?.focus();
    }, [selectOnFocus]);
    return <input {...props} ref={input} className={cn(props.className)} onKeyDown={onKeyDown} />;
}
