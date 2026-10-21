import { FileText, LoaderCircle, Maximize2, Minimize2, RotateCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { dataTestId } from "../../data-testid.ts";
import type { HtmlPreviewFailure } from "../../services/chat/html-preview-document.ts";
import type { FilePreviewState } from "../../view-models/chat/file-preview-store.ts";
import { HtmlPreview } from "./html-preview.tsx";
import { HighlightedCode, languageForPath } from "./tools/highlighted-code.tsx";

const SIDE_PANEL_QUERY = "(min-width: 40rem) and (hover: hover) and (pointer: fine)";

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
    onHtmlFailure,
}: {
    readonly state: FilePreviewState;
    readonly onHtmlFailure: (id: string, code: HtmlPreviewFailure) => void;
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
        case "failed":
            return (
                <p className="text-sm text-destructive" role="alert">
                    {state.message}
                </p>
            );
        case "text":
            return <PreviewSource name={state.name} text={state.text} />;
        case "image":
            return <PreviewImage state={state} />;
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
                    <HtmlPreview
                        document={state.view.document}
                        key={state.view.document.id}
                        onFailure={onHtmlFailure}
                    />
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
    onHtmlFailure,
    state,
}: {
    readonly onClose: () => void;
    readonly onReload: () => void;
    readonly onHtmlView: (view: "preview" | "source") => void;
    readonly onHtmlFailure: (id: string, code: HtmlPreviewFailure) => void;
    readonly state: FilePreviewState;
}) {
    const [expanded, setExpanded] = useState(false);
    const [sidePanelLayout, setSidePanelLayout] = useState(() => window.matchMedia(SIDE_PANEL_QUERY).matches);
    const panel = useRef<HTMLDialogElement>(null);
    const closeButton = useRef<HTMLButtonElement>(null);
    const open = state.kind !== "closed";
    useEffect(() => {
        const query = window.matchMedia(SIDE_PANEL_QUERY);
        const update = () => setSidePanelLayout(query.matches);
        query.addEventListener("change", update);
        update();
        return () => query.removeEventListener("change", update);
    }, []);
    useLayoutEffect(() => {
        if (!open) {
            setExpanded(false);
            return;
        }
        const dialog = panel.current;
        const previousFocus = document.activeElement;
        return () => {
            dialog?.close();
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
                previousFocus.focus({ preventScroll: true });
            }
        };
    }, [open]);
    const modal = expanded || !sidePanelLayout;
    useLayoutEffect(() => {
        const dialog = panel.current;
        if (!open || dialog === null) {
            return;
        }
        const previousFocus = document.activeElement;
        const wasOpen = dialog.open;
        if (wasOpen) {
            dialog.close();
        }
        // Native modal focus handling also contains keyboard navigation inside
        // the opaque iframe. Keep the same DOM when resizing or expanding so the
        // preview's input and rendering state survive.
        if (modal) {
            dialog.showModal();
        } else {
            dialog.show();
        }
        if (wasOpen && previousFocus instanceof HTMLElement && dialog.contains(previousFocus)) {
            previousFocus.focus({ preventScroll: true });
        } else {
            closeButton.current?.focus({ preventScroll: true });
        }
    }, [open, modal]);
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
            ref={panel}
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
                    onClick={() => setExpanded((value) => !value)}
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
                    ref={closeButton}
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
                <PreviewContent onHtmlFailure={onHtmlFailure} state={state} />
            </div>
        </dialog>
    );
}
