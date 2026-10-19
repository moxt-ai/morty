import { Check, Copy } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { setupMonoFieldClassName, setupPrimaryButtonClassName } from "./setup-card-shell.tsx";

export function SetupCopyableField({
    ariaLabel,
    copyButtonLabel,
    copiedLabel = "Copied",
    fieldTestId,
    value,
}: {
    readonly ariaLabel: string;
    readonly copyButtonLabel: string;
    readonly copiedLabel?: string;
    readonly fieldTestId?: string;
    readonly value: string;
}) {
    const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
    const fieldRef = useRef<HTMLTextAreaElement>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Resync textarea height when the copied value changes.
    useLayoutEffect(() => {
        const element = fieldRef.current;
        if (!element) {
            return;
        }
        element.style.height = "auto";
        element.style.height = `${element.scrollHeight}px`;
    }, [value]);
    useLayoutEffect(() => {
        const element = fieldRef.current;
        if (!element) {
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
    useEffect(() => {
        if (copy !== "copied") {
            return;
        }
        const timeoutId = window.setTimeout(() => {
            setCopy((current) => (current === "copied" ? "idle" : current));
        }, 2000);
        return () => window.clearTimeout(timeoutId);
    }, [copy]);
    return (
        <>
            <textarea
                ref={fieldRef}
                aria-label={ariaLabel}
                data-testid={fieldTestId}
                readOnly
                rows={1}
                value={value}
                onFocus={(event) => event.currentTarget.select()}
                className={setupMonoFieldClassName}
            />
            <Button
                type="button"
                variant="primary"
                className={setupPrimaryButtonClassName}
                aria-label={copyButtonLabel}
                title={copyButtonLabel}
                onClick={() => {
                    void navigator.clipboard.writeText(value).then(
                        () => {
                            setCopy("copied");
                        },
                        () => {
                            setCopy("failed");
                        },
                    );
                }}
            >
                {copy === "copied" ? (
                    <Check aria-hidden="true" className="size-4" />
                ) : (
                    <Copy aria-hidden="true" className="size-4" />
                )}
                {copy === "copied" ? copiedLabel : copyButtonLabel}
            </Button>
            {copy === "failed" ? (
                <p className="text-xs text-muted-foreground">Select the text to copy it manually.</p>
            ) : null}
        </>
    );
}
