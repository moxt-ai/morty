import { FileText, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { dataTestId } from "../../data-testid.ts";
import type { FilePreviewState } from "../../view-models/chat/file-preview-store.ts";
import { HighlightedCode, languageForPath } from "./tools/highlighted-code.tsx";

function PreviewImage({ state }: { readonly state: Extract<FilePreviewState, { readonly kind: "image" }> }) {
    const [source, setSource] = useState("");
    useEffect(() => {
        const url = URL.createObjectURL(new Blob([Uint8Array.from(state.bytes)], { type: state.mediaType }));
        setSource(url);
        return () => URL.revokeObjectURL(url);
    }, [state.bytes, state.mediaType]);
    return source.length > 0 ? (
        <img
            alt={state.name}
            className="max-h-full max-w-full object-contain"
            data-testid={dataTestId.filePreviewContent}
            src={source}
        />
    ) : null;
}

export function FilePreview({ onClose, state }: { readonly onClose: () => void; readonly state: FilePreviewState }) {
    if (state.kind === "closed") {
        return null;
    }
    const title = state.kind === "text" || state.kind === "image" ? state.name : state.path;
    return (
        <aside
            aria-label="Local file preview"
            className="fixed inset-0 z-50 flex w-full flex-col border-l border-border bg-surface-elevated shadow-2xl sm:static sm:z-auto sm:min-h-0 sm:w-[min(50vw,56rem)] sm:shrink-0"
            data-testid={dataTestId.filePreview}
        >
            <header className="flex min-h-14 items-center gap-3 border-b border-border px-4">
                <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={state.path}>
                    {title}
                </span>
                <button
                    aria-label="Close file preview"
                    className="inline-flex size-9 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/70"
                    data-testid={dataTestId.closeFilePreview}
                    onClick={onClose}
                    type="button"
                >
                    <X aria-hidden="true" className="size-4" />
                </button>
            </header>
            <div
                className={cn(
                    "flex min-h-0 flex-1 overflow-auto",
                    state.kind === "text"
                        ? "items-stretch justify-stretch bg-white"
                        : "items-center justify-center bg-surface-subtle p-5",
                )}
            >
                {state.kind === "loading" ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Loading file…
                    </div>
                ) : state.kind === "failed" ? (
                    <p className="text-sm text-destructive">{state.message}</p>
                ) : state.kind === "text" ? (
                    <div
                        className="min-h-full w-full overflow-hidden bg-white [&_pre]:!max-h-none"
                        data-testid={dataTestId.filePreviewContent}
                    >
                        <HighlightedCode bare code={state.text} language={languageForPath(state.name)} />
                    </div>
                ) : (
                    <PreviewImage state={state} />
                )}
            </div>
        </aside>
    );
}
