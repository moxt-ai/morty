import Anser from "anser";
import { Check, Copy } from "lucide-react";
import { type CSSProperties, useRef, useState } from "react";
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
    const content = useRef<HTMLPreElement>(null);
    const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
    const label = copy === "copied" ? "Copied" : copy === "failed" ? "Copy unavailable" : "Copy shell output";
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
        <div className="group/code relative min-w-0">
            <pre
                className="m-0 max-h-96 overflow-auto p-4 pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap"
                data-testid={dataTestId.ansiShellOutput}
                ref={content}
            >
                <code className="font-inherit">
                    {positionedSegments.map(({ key, segment }) => (
                        <span key={key} style={segmentStyle(segment)}>
                            {segment.content}
                        </span>
                    ))}
                </code>
            </pre>
            <button
                aria-label={label}
                className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-black/[0.06] hover:text-foreground focus:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60 group-hover/code:opacity-100 motion-reduce:transition-none"
                onClick={() => {
                    if (navigator.clipboard === undefined) {
                        setCopy("failed");
                        return;
                    }
                    void navigator.clipboard.writeText(content.current?.textContent ?? "").then(
                        () => setCopy("copied"),
                        () => setCopy("failed"),
                    );
                }}
                title={label}
                type="button"
            >
                {copy === "copied" ? (
                    <Check aria-hidden="true" className="size-3.5" />
                ) : (
                    <Copy aria-hidden="true" className="size-3.5" />
                )}
            </button>
        </div>
    );
}
