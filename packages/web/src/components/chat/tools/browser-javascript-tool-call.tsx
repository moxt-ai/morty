import { Monitor } from "lucide-react";
import * as v from "valibot";
import { AgentRichContent } from "../../agents/agent-rich-content.tsx";
import { HighlightedCode } from "./highlighted-code.tsx";
import { ToolCallStatus, useToolCallDisclosure } from "./tool-call-status.tsx";
import { toolRichContent, toolTextContent } from "./tool-display-content.ts";
import type { ToolRendererProps } from "./tool-renderer.ts";

const requestSchema = v.pipe(
    v.strictObject({
        code: v.pipe(v.string(), v.minLength(1)),
        timeout_ms: v.optional(v.pipe(v.number(), v.finite(), v.minValue(1))),
        title: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
);
const responseSchema = v.pipe(v.object({ content: v.pipe(v.array(v.unknown()), v.readonly()) }), v.readonly());
const textContentSchema = v.pipe(
    v.object({
        text: v.string(),
        type: v.literal("text"),
    }),
    v.readonly(),
);

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

function parseRequest(value: string): v.InferOutput<typeof requestSchema> | null {
    const request = v.safeParse(requestSchema, parseJson(value));
    return request.success ? request.output : null;
}

function responseText(value: string): string | null {
    const decoded = parseJson(value);
    if (decoded === null) {
        return "";
    }
    const response = v.safeParse(responseSchema, decoded);
    if (!response.success) {
        return null;
    }
    return response.output.content
        .flatMap((item) => {
            const content = v.safeParse(textContentSchema, item);
            return content.success ? [content.output.text] : [];
        })
        .join("\n");
}

export function matchesBrowserJavascriptToolCall(entry: ToolRendererProps["entry"]): boolean {
    return entry.name === "cua_repl/js" || parseRequest(entry.input) !== null;
}

export function BrowserJavascriptToolCall({ autoOpen, entry }: ToolRendererProps) {
    const request = parseRequest(entry.input);
    const disclosure = useToolCallDisclosure(autoOpen);
    const title = request?.title ?? entry.title;
    const protocolResponse = responseText(entry.output);
    const output = toolTextContent(entry.content) ?? protocolResponse ?? entry.output;
    const richContent = toolRichContent(entry.content);
    return (
        <details aria-label={`Browser: ${title}`} className="group/tool min-w-0" ref={disclosure}>
            <summary
                className="flex min-h-8 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                title={title}
            >
                <Monitor aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{title}</span>
                <ToolCallStatus state={entry.state} />
            </summary>
            <div className="mt-1 ml-5 grid min-w-0 gap-2 text-xs">
                {request !== null && (
                    <div className="overflow-hidden rounded-lg bg-black/[0.035]">
                        <HighlightedCode code={request.code} language="javascript" />
                    </div>
                )}
                {output.length > 0 && (
                    <pre className="max-h-96 overflow-auto rounded-lg bg-black/[0.035] p-2 whitespace-pre-wrap">
                        {output}
                    </pre>
                )}
                {richContent.length > 0 && <AgentRichContent contents={richContent} />}
            </div>
        </details>
    );
}
