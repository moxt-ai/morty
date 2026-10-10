import { lazy, memo, Suspense } from "react";
import { CodeBlock, CodeBlockCopyButton, type CustomRendererProps } from "streamdown";
import { MAX_MERMAID_CHARACTERS } from "./mermaid-options.ts";
import { INCOMPLETE_MERMAID_META } from "./remark-mermaid-completion.ts";

function MermaidSource({ code, message }: { readonly code: string; readonly message: string }) {
    return (
        <div>
            <p className="text-sm text-muted-foreground" role="status">
                {message}
            </p>
            <CodeBlock code={code} language="mermaid" lineNumbers={false}>
                <CodeBlockCopyButton code={code} />
            </CodeBlock>
        </div>
    );
}

const MermaidDiagram = lazy(() =>
    import("./mermaid-diagram.tsx").catch(() => ({
        default: memo(({ code }: { readonly code: string }) => (
            <MermaidSource code={code} message="Diagram could not be loaded. You can still copy its source." />
        )),
    })),
);

export const MermaidCodeBlock = memo(function MermaidCodeBlock({ code, meta }: Readonly<CustomRendererProps>) {
    if (meta === INCOMPLETE_MERMAID_META) {
        return <MermaidSource code={code} message="Waiting for the diagram to finish…" />;
    }
    if (code.length > MAX_MERMAID_CHARACTERS) {
        return <MermaidSource code={code} message="Diagram is too large to display. You can still copy its source." />;
    }
    return (
        <Suspense fallback={<MermaidSource code={code} message="Loading diagram…" />}>
            <MermaidDiagram code={code} />
        </Suspense>
    );
});
