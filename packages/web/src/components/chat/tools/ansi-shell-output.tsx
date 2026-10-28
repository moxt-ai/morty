import Anser from "anser";
import type { CSSProperties } from "react";
import { dataTestId } from "../../../data-testid.ts";
import { isOversizedToolText, ToolTextPreview } from "../tool-text-preview.tsx";

function color(value: string | null | undefined): string | undefined {
    return value === null || value === undefined || value.length === 0 ? undefined : `rgb(${value})`;
}

function segmentStyle(segment: Anser.AnserJsonEntry): CSSProperties {
    const reversed = segment.decorations.includes("reverse");
    const foreground = color(segment.fg_truecolor || segment.fg);
    const background = color(segment.bg_truecolor || segment.bg);
    const textDecorations = [
        ...(segment.decorations.includes("underline") ? ["underline"] : []),
        ...(segment.decorations.includes("strikethrough") ? ["line-through"] : []),
    ];
    return {
        backgroundColor: reversed ? foreground : background,
        color: reversed ? background : foreground,
        fontStyle: segment.decorations.includes("italic") ? "italic" : undefined,
        fontWeight: segment.decorations.includes("bold") ? "bold" : undefined,
        opacity: segment.decorations.includes("dim") ? 0.5 : undefined,
        textDecoration: textDecorations.length === 0 ? undefined : textDecorations.join(" "),
        visibility: segment.decorations.includes("hidden") ? "hidden" : undefined,
    };
}

export function AnsiShellOutput({ output }: { readonly output: string }) {
    if (isOversizedToolText(output)) {
        return <ToolTextPreview className="p-4 pr-10 font-mono text-xs leading-relaxed" text={output} />;
    }
    const segments = Anser.ansiToJson(output, { json: true, remove_empty: true });
    let offset = 0;
    const positionedSegments = segments.map((segment) => {
        const key = `${offset}:${segment.content.length}`;
        offset += segment.content.length;
        return { key, segment };
    });
    return (
        <div className="relative min-w-0">
            <pre
                className="m-0 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap"
                data-testid={dataTestId.ansiShellOutput}
            >
                <code className="font-inherit">
                    {positionedSegments.map(({ key, segment }) => (
                        <span key={key} style={segmentStyle(segment)}>
                            {segment.content}
                        </span>
                    ))}
                </code>
            </pre>
        </div>
    );
}
