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
                className="-ml-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-morty-text-3 transition-colors hover:bg-morty-fill-opacity-2 hover:text-foreground active:bg-morty-fill-opacity-3 active:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 motion-reduce:transition-none"
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
