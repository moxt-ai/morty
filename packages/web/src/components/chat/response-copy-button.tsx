import { Check, Copy } from "lucide-react";
import { useMemo } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

export interface ResponseCopyModel {
    readonly state:
        | { readonly kind: "idle" | "copying" | "copied" }
        | { readonly kind: "failed"; readonly message: string };
    readonly copy: () => void;
    readonly onAttach: (node: HTMLElement | null) => (() => void) | undefined;
}

export type ResponseCopyStoreFactory = (text: string) => StoreApi<ResponseCopyModel>;

export function ResponseCopyButton({
    text,
    createStore,
}: {
    readonly text: string;
    readonly createStore: ResponseCopyStoreFactory;
}) {
    const store = useMemo(() => createStore(text), [createStore, text]);
    const model = useStore(store);
    const copy = model.state.kind;

    return (
        <div className="mt-2 flex flex-wrap items-center gap-x-3" ref={model.onAttach}>
            <button
                aria-label={copy === "copied" ? "Copied" : "Copy response"}
                className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none keyboard-focus:focus-visible:ring-2 keyboard-focus:focus-visible:ring-ring/60 motion-reduce:transition-none"
                aria-disabled={copy === "copying"}
                onClick={model.copy}
                title="Copy response as Markdown"
                type="button"
            >
                {copy === "copied" ? (
                    <Check aria-hidden="true" className="size-3.5" />
                ) : (
                    <Copy aria-hidden="true" className="size-3.5" />
                )}
                {copy === "copied" ? "Copied" : copy === "failed" ? "Retry copy" : "Copy"}
            </button>
            <span className="sr-only" role="status">
                {copy === "copied" ? "Response copied to clipboard" : ""}
            </span>
            {model.state.kind === "failed" && (
                <span className="text-xs text-muted-foreground" role="alert">
                    {model.state.message}
                </span>
            )}
        </div>
    );
}
