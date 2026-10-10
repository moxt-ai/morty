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

function CodeLineNumbers({ code }: { readonly code: string }) {
    const lineCount = code.split("\n").length;
    return (
        <div
            aria-hidden="true"
            className="sticky left-0 z-10 self-stretch border-r border-border/70 bg-surface-subtle px-3 py-4 text-right font-mono text-xs leading-4 text-muted-foreground select-none"
            data-testid={dataTestId.filePreviewLineNumbers}
        >
            {Array.from({ length: lineCount }, (_, index) => (
                <span className="block h-4" data-line-number="" key={index.toString()}>
                    {index + 1}
                </span>
            ))}
        </div>
    );
}

export function FilePreview({ onClose, state }: { readonly onClose: () => void; readonly state: FilePreviewState }) {
    if (state.kind === "closed") {
        return null;
    }
    const title = state.kind === "text" || state.kind === "image" ? state.name : state.path;
    return (
        <aside
            aria-label="Local file preview"
            className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface-elevated shadow-2xl sm:w-[min(50vw,56rem)]"
            data-testid={dataTestId.filePreview}
        >
            <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4">
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
                    "flex min-h-0 flex-1",
                    state.kind === "text"
                        ? "items-stretch justify-stretch overflow-hidden bg-white"
                        : "items-center justify-center overflow-auto bg-surface-subtle p-5",
                )}
            >
                {state.kind === "loading" ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Loading file…
                    </div>
                ) : state.kind === "failed" ? (
                    <p className="text-sm text-destructive">{state.message}</p>
                ) : state.kind === "text" ? (
                    <section
                        aria-label="File contents"
                        className="h-full min-h-0 w-full overflow-auto bg-white [scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring [&_pre]:!max-h-none"
                        data-testid={dataTestId.filePreviewContent}
                        // biome-ignore lint/a11y/noNoninteractiveTabindex: the scroll region must be keyboard reachable
                        tabIndex={0}
                    >
                        <div className="flex min-w-0 items-start">
                            <CodeLineNumbers code={state.text} />
                            <div className="min-w-0 flex-1 [&_pre]:leading-4">
                                <HighlightedCode bare code={state.text} language={languageForPath(state.name)} />
                            </div>
                        </div>
                    </section>
                ) : (
                    <PreviewImage state={state} />
                )}
            </div>
        </aside>
    );
}
