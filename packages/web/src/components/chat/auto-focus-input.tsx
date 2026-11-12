import { useEffect, useRef } from "react";

/**
 * A text input that focuses and selects itself whenever it (re)mounts.
 * Ownership of the element stays here; callers pass value and handlers.
 * Recorded effect exception: the effect only drives this element's own
 * focus/selection — DOM-ephemeral state, no asynchronous workflow.
 */
export function AutoFocusInput(props: React.ComponentPropsWithoutRef<"input">) {
    const input = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        input.current?.select();
        input.current?.focus();
    }, []);
    return <input {...props} ref={input} />;
}
