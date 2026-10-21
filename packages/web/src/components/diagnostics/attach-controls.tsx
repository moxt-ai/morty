import { Paperclip } from "lucide-react";
import { type ReactNode, useCallback, useRef } from "react";
import { Button } from "../ui/cloud-button.tsx";

/**
 * Runs the cancel callback when this boundary unmounts, following React's
 * ref-cleanup protocol. The callback may change identity between renders;
 * only the latest one runs at unmount and re-renders never re-run it.
 */
export function AttachCancelBoundary({
    cancel,
    children,
}: {
    readonly cancel: () => void;
    readonly children: ReactNode;
}) {
    // Keep the latest cancel without re-creating the ref callback, so a
    // re-render never runs the cleanup of an earlier attach.
    const cancelRef = useRef(cancel);
    cancelRef.current = cancel;
    const cancelOnUnmount = useCallback((node: HTMLElement | null): (() => void) | undefined => {
        if (node === null) {
            return undefined;
        }
        return () => {
            cancelRef.current();
        };
    }, []);
    return <div ref={cancelOnUnmount}>{children}</div>;
}

/**
 * A hidden file input paired with its "Attach images" trigger button. The
 * input owns its DOM ref inside this component, so callers never hold one.
 */
export function HiddenFileInput({
    accept,
    ariaLabel,
    disabled,
    multiple,
    onFiles,
}: {
    readonly accept: string;
    readonly ariaLabel: string;
    readonly disabled: boolean;
    readonly multiple: boolean;
    readonly onFiles: (files: readonly File[]) => void;
}) {
    const fileInput = useRef<HTMLInputElement>(null);
    return (
        <>
            <input
                ref={fileInput}
                type="file"
                aria-label={ariaLabel}
                accept={accept}
                multiple={multiple}
                hidden
                disabled={disabled}
                onChange={(event) => {
                    onFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                }}
            />
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => fileInput.current?.click()}>
                <Paperclip aria-hidden="true" className="size-4" />
                Attach images
            </Button>
        </>
    );
}
