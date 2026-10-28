import { memo, type MouseEvent as ReactMouseEvent, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { MermaidFullscreen, type MermaidFullscreenDiagram } from "./mermaid-fullscreen.tsx";
import { mermaidConfig } from "./mermaid-options.ts";
import { mermaidPlugin } from "./mermaid-plugin.ts";

const plugins = { mermaid: mermaidPlugin };
const controls = { mermaid: { copy: false, fullscreen: true, panZoom: true, download: false } };
const translations = { viewFullscreen: "View diagram fullscreen" };
const options = {
    config: mermaidConfig,
    errorComponent: () => (
        <p className="p-3 text-sm text-muted-foreground" role="status">
            Diagram could not be displayed. Its source is still available.
        </p>
    ),
};

function measureDiagram(svg: SVGSVGElement): MermaidFullscreenDiagram | null {
    const viewBox = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/u);
    const width = Number(viewBox[2]);
    const height = Number(viewBox[3]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }
    return { height, markup: svg.outerHTML, width };
}

export default memo(function MermaidDiagram({ code }: { readonly code: string }) {
    const container = useRef<HTMLDivElement | null>(null);
    const [fullscreen, setFullscreen] = useState<MermaidFullscreenDiagram | null>(null);
    // A nested renderer reuses Streamdown's supported diagram controls without registering
    // our custom fence renderer recursively. The engine only loads for complete diagrams.
    const longestFence = Math.max(0, ...Array.from(code.matchAll(/`+/gu), (match) => match[0].length));
    const fence = "`".repeat(Math.max(3, longestFence + 1));
    const openFullscreen = (event: ReactMouseEvent<HTMLDivElement>) => {
        // Streamdown sizes its fullscreen diagram inside the viewport and then fits the
        // same diagram again, so a wide diagram opens unreadably small on a phone. Take
        // over this one control, and leave Streamdown's overlay for a diagram that has
        // not rendered (its loading and failure states).
        if (!(event.target instanceof Element)) {
            return;
        }
        const trigger = event.target.closest("button");
        const svg = container.current?.querySelector('[role="img"] > svg');
        if (trigger?.getAttribute("aria-label") !== translations.viewFullscreen || !(svg instanceof SVGSVGElement)) {
            return;
        }
        const diagram = measureDiagram(svg);
        if (diagram === null) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        setFullscreen(diagram);
    };
    return (
        <div className="agent-mermaid relative min-w-0" onClickCapture={openFullscreen} ref={container}>
            <Streamdown
                controls={controls}
                mermaid={options}
                mode="static"
                plugins={plugins}
                translations={translations}
            >
                {`${fence}mermaid\n${code}\n${fence}`}
            </Streamdown>
            <details className="my-2 text-sm">
                <summary className="cursor-pointer text-muted-foreground">View diagram source</summary>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3">{code}</pre>
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
