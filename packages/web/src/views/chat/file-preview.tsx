import { FileText, LoaderCircle, Maximize2, Minimize2, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { HighlightedCode, languageForPath } from "../../components/chat/highlighted-code.tsx";
import { HtmlPreview } from "../../components/chat/html-preview.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { FilePreviewLayout, FilePreviewState } from "../../view-models/chat/file-preview-store.ts";
import { describePageFailure } from "../../view-models/format-error.ts";

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

function PreviewSource({ name, text }: { readonly name: string; readonly text: string }) {
    return (
        <section
            aria-label="File contents"
            className="h-full min-h-0 w-full overflow-auto bg-white [scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring [&_pre]:!max-h-none"
            data-testid={dataTestId.filePreviewContent}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the scroll region must be keyboard reachable
            tabIndex={0}
        >
            <div className="flex min-w-0 items-start">
                <CodeLineNumbers code={text} />
                <div className="min-w-0 flex-1 [&_pre]:leading-4">
                    <HighlightedCode bare code={text} language={languageForPath(name)} />
                </div>
            </div>
        </section>
    );
}

function PreviewContent({
    state,
    onHtmlAttach,
}: {
    readonly state: FilePreviewState;
    readonly onHtmlAttach: (frame: HTMLIFrameElement) => () => void;
}) {
    switch (state.kind) {
        case "closed":
            return null;
        case "loading":
            return (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Loading file…
                </div>
            );
        case "failed": {
            const copy = describePageFailure(state.message, "Couldn't open this file");
            return (
                <div className="grid max-w-sm justify-items-center gap-2 text-center" role="alert">
                    <p className="text-[18px] leading-6 font-semibold tracking-[-0.025em] [overflow-wrap:anywhere]">
                        {copy.title}
                    </p>
                    <p className="text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">{copy.content}</p>
                </div>
            );
        }
        case "text":
            return <PreviewSource name={state.name} text={state.text} />;
        case "image":
            return (
                <img
                    alt={state.name}
                    className="max-h-full max-w-full object-contain"
                    data-testid={dataTestId.filePreviewContent}
                    src={state.source}
                />
            );
        case "html":
            return state.view.kind === "source" ? (
                <PreviewSource name={state.name} text={state.text} />
            ) : (
                <div className="flex min-h-0 w-full flex-1 flex-col">
                    {state.view.diagnostic.kind === "failed" ? (
                        <p className="shrink-0 border-b border-border bg-surface-subtle px-4 py-3 text-sm" role="alert">
                            {state.view.diagnostic.message}
                        </p>
                    ) : null}
                    <HtmlPreview key={state.view.document.id} onAttach={onHtmlAttach} />
                </div>
            );
        default: {
            const exhaustive: never = state;
            return exhaustive;
        }
    }
}

export function FilePreview({
    onClose,
    onReload,
    onHtmlView,
    onHtmlAttach,
    onPanelAttach,
    onToggleExpanded,
    layout,
    state,
}: {
    readonly onClose: () => void;
    readonly onReload: () => void;
    readonly onHtmlView: (view: "preview" | "source") => void;
    readonly onHtmlAttach: (frame: HTMLIFrameElement) => () => void;
    readonly layout: FilePreviewLayout;
    readonly onPanelAttach: (panel: HTMLDialogElement) => () => void;
    readonly onToggleExpanded: () => void;
    readonly state: FilePreviewState;
}) {
    const sidePanelLayout = layout.kind === "desktop";
    const expanded = layout.kind === "desktop" && layout.size === "expanded";
    if (state.kind === "closed") {
        return null;
    }
    const title = state.kind === "loading" || state.kind === "failed" ? state.path : state.name;
    return (
        <dialog
            aria-label="Local file preview"
            className={cn(
                "fixed inset-y-0 left-auto right-0 z-50 m-0 flex h-dvh max-h-none w-full max-w-none flex-col border-0 border-l border-border bg-surface-elevated p-0 text-foreground shadow-2xl outline-none backdrop:bg-transparent",
                !expanded && sidePanelLayout && "w-[min(50vw,56rem)]",
            )}
            data-testid={dataTestId.filePreview}
            onCancel={(event) => {
                event.preventDefault();
                onClose();
            }}
            onKeyDown={(event) => {
                if (event.key === "Escape" && !event.defaultPrevented) {
                    event.preventDefault();
                    onClose();
                }
            }}
            ref={onPanelAttach}
        >
            <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4">
                <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={state.path}>
                    {title}
                </span>
                <button
                    aria-label={expanded ? "Collapse preview" : "Expand preview"}
                    className={cn(
                        "size-9 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/70",
                        sidePanelLayout ? "inline-flex" : "hidden",
                    )}
                    onClick={onToggleExpanded}
                    type="button"
                >
                    {expanded ? (
                        <Minimize2 aria-hidden="true" className="size-4" />
                    ) : (
                        <Maximize2 aria-hidden="true" className="size-4" />
                    )}
                </button>
                <button
                    aria-label="Close file preview"
                    className="inline-flex size-9 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/70"
                    data-testid={dataTestId.closeFilePreview}
                    onClick={onClose}
                    data-preview-initial-focus=""
                    type="button"
                >
                    <X aria-hidden="true" className="size-4" />
                </button>
            </header>
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                {state.kind === "html" ? (
                    <button
                        aria-label={state.view.kind === "preview" ? "View source" : "Show preview"}
                        className="rounded-md px-3 py-2 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/70"
                        onClick={() => onHtmlView(state.view.kind === "preview" ? "source" : "preview")}
                        type="button"
                    >
                        {state.view.kind === "preview" ? "View source" : "Show preview"}
                    </button>
                ) : null}
                <button
                    aria-label="Reload file"
                    className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-50"
                    disabled={state.kind === "loading"}
                    onClick={onReload}
                    type="button"
                >
                    <RotateCw aria-hidden="true" className="size-4" /> Reload
                </button>
            </div>
            <div
                className={cn(
                    "flex min-h-0 flex-1",
                    state.kind === "text" || state.kind === "html"
                        ? "items-stretch justify-stretch overflow-hidden bg-white"
                        : "items-center justify-center overflow-auto bg-surface-subtle p-5",
                )}
            >
                <PreviewContent onHtmlAttach={onHtmlAttach} state={state} />
            </div>
        </dialog>
    );
}
