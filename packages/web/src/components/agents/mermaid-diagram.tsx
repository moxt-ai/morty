import { Maximize2 } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { MermaidFullscreen } from "./mermaid-fullscreen.tsx";
import { type RenderedDiagram, renderMermaid } from "./mermaid-renderer.ts";

type Rendering = { readonly code: string } & (
    | { readonly kind: "ready"; readonly diagram: RenderedDiagram }
    | { readonly kind: "failed" }
);

// Start rendering slightly before a diagram scrolls into view, so it is drawn by the time it is read.
const RENDER_AHEAD = "300px";

/**
 * A diagram in the conversation is a figure to read, like an image: it fits the column, and the
 * wheel, a drag or a swipe over it keeps scrolling the conversation. Zoom and pan live in the
 * fullscreen viewer, where there is no surrounding page to scroll.
 */
export default memo(function MermaidDiagram({ code }: { readonly code: string }) {
    const [figure, setFigure] = useState<HTMLElement | null>(null);
    const [rendering, setRendering] = useState<Rendering | null>(null);
    const [fullscreen, setFullscreen] = useState<RenderedDiagram | null>(null);
    const current = rendering?.code === code ? rendering : null;
    useEffect(() => {
        if (figure === null) {
            return;
        }
        let active = true;
        const observer = new IntersectionObserver(
            (entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) {
                    return;
                }
                observer.disconnect();
                renderMermaid(code).then(
                    (diagram) => {
                        if (active) {
                            setRendering({ code, kind: "ready", diagram });
                        }
                    },
                    () => {
                        if (active) {
                            setRendering({ code, kind: "failed" });
                        }
                    },
                );
            },
            { rootMargin: RENDER_AHEAD },
        );
        observer.observe(figure);
        return () => {
            active = false;
            observer.disconnect();
        };
    }, [code, figure]);
    return (
        <div className="min-w-0">
            <figure
                className="relative my-4 flex w-full flex-col gap-2 rounded-md border border-border/60 bg-surface-subtle p-3"
                ref={setFigure}
            >
                <div className="flex h-8 items-center text-xs text-muted-foreground">
                    <span className="ml-1 font-mono lowercase">mermaid</span>
                </div>
                {current?.kind === "ready" && (
                    <button
                        aria-label="View diagram fullscreen"
                        className="absolute top-3 right-3 cursor-pointer p-1 text-muted-foreground transition-colors hover:text-foreground"
                        onClick={() => {
                            setFullscreen(current.diagram);
                        }}
                        title="View diagram fullscreen"
                        type="button"
                    >
                        <Maximize2 aria-hidden="true" size={14} />
                    </button>
                )}
                {current === null && (
                    <p className="p-3 text-sm text-muted-foreground" role="status">
                        Loading diagram…
                    </p>
                )}
                {current?.kind === "failed" && (
                    <p className="p-3 text-sm text-muted-foreground" role="status">
                        Diagram could not be displayed. Its source is still available.
                    </p>
                )}
                {current?.kind === "ready" && (
                    <div
                        aria-label="Mermaid chart"
                        className="flex justify-center bg-surface-subtle p-4 [&>svg]:h-auto [&>svg]:max-h-[min(70vh,40rem)] [&>svg]:w-auto [&>svg]:max-w-full"
                        // biome-ignore lint/security/noDangerouslySetInnerHtml: the Mermaid renderer sanitizes this markup with DOMPurify before it reaches the page.
                        dangerouslySetInnerHTML={{ __html: current.diagram.markup }}
                        role="img"
                    />
                )}
            </figure>
            <details className="my-2 text-sm">
                <summary className="cursor-pointer text-muted-foreground">View diagram source</summary>
                <ScrollArea className="max-h-80" orientation="both" viewportClassName="max-h-[inherit] p-3">
                    <pre className="whitespace-pre-wrap break-words">{code}</pre>
                </ScrollArea>
            </details>
            {fullscreen !== null && (
                <MermaidFullscreen
                    diagram={fullscreen}
                    onClose={() => {
                        setFullscreen(null);
                    }}
                />
            )}
        </div>
    );
});
