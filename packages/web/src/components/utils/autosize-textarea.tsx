import { type ComponentPropsWithoutRef, useLayoutEffect, useRef } from "react";

/** A read-only textarea that grows to its content, including after the width changes. */
export function AutosizeTextarea({ value, ...props }: ComponentPropsWithoutRef<"textarea">) {
    const fieldRef = useRef<HTMLTextAreaElement>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Resync height when the value changes.
    useLayoutEffect(() => {
        const element = fieldRef.current;
        if (element === null) {
            return;
        }
        element.style.height = "auto";
        element.style.height = `${element.scrollHeight}px`;
    }, [value]);
    useLayoutEffect(() => {
        const element = fieldRef.current;
        if (element === null) {
            return;
        }
        const syncHeight = () => {
            element.style.height = "auto";
            element.style.height = `${element.scrollHeight}px`;
        };
        const resizeObserver = new ResizeObserver(syncHeight);
        resizeObserver.observe(element);
        return () => resizeObserver.disconnect();
    }, []);
    return <textarea ref={fieldRef} value={value} {...props} />;
}
