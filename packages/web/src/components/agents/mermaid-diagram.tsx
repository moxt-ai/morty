import { memo } from "react";
import { Streamdown } from "streamdown";
import { mermaidConfig } from "./mermaid-options.ts";
import { mermaidPlugin } from "./mermaid-plugin.ts";

const plugins = { mermaid: mermaidPlugin };
const controls = { mermaid: { copy: true, fullscreen: true, panZoom: true, download: false } };
const translations = { copyCode: "Copy diagram source", viewFullscreen: "View diagram fullscreen" };
const options = {
    config: mermaidConfig,
    errorComponent: () => (
        <p className="p-3 text-sm text-muted-foreground" role="status">
            Diagram could not be displayed. Its source is still available.
        </p>
    ),
};

export default memo(function MermaidDiagram({ code }: { readonly code: string }) {
    // A nested renderer reuses Streamdown's supported diagram controls without registering
    // our custom fence renderer recursively. The engine only loads for complete diagrams.
    const longestFence = Math.max(0, ...Array.from(code.matchAll(/`+/gu), (match) => match[0].length));
    const fence = "`".repeat(Math.max(3, longestFence + 1));
    return (
        <div className="agent-mermaid min-w-0">
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
        </div>
    );
});
