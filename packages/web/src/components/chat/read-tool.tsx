import { FileText } from "lucide-react";
import * as v from "valibot";
import { dataTestId } from "../../data-testid.ts";
import type { ToolCallState } from "../../services/chat/agent-reply.ts";
import { HighlightedCode, languageForPath } from "./highlighted-code.tsx";
import { ToolCallStatus, useToolCallDisclosure } from "./tool-call-status.tsx";

const readResponseSchema = v.pipe(
    v.strictObject({
        exit_code: v.optional(v.number()),
        formatted_output: v.string(),
    }),
    v.readonly(),
);
const readRequestSchema = v.pipe(
    v.strictObject({
        limit: v.optional(v.number()),
        offset: v.optional(v.number()),
        path: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
);

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function readOutput(value: string): { readonly text: string } | null {
    const result = v.safeParse(readResponseSchema, parseJson(value));
    return result.success ? { text: result.output.formatted_output.trimEnd() } : null;
}

export function matchesReadTool(input: string, output: string): boolean {
    return v.safeParse(readRequestSchema, parseJson(input)).success || readOutput(output) !== null;
}

export function ReadTool({
    autoOpen,
    input,
    output,
    state,
    title,
}: {
    readonly autoOpen: boolean;
    readonly input: string;
    readonly output: string;
    readonly state: ToolCallState;
    readonly title: string;
}) {
    const response = readOutput(output);
    const disclosure = useToolCallDisclosure(autoOpen);
    return (
        <details
            aria-label={`Read: ${title}`}
            className="group/tool min-w-0"
            data-testid={dataTestId.recognizedReadToolCall}
            ref={disclosure}
        >
            <summary
                className="flex min-h-8 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                title={title}
            >
                <FileText aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{title}</span>
                <ToolCallStatus state={state} />
            </summary>
            <div className="mt-1 ml-5 grid min-w-0 gap-2 text-xs">
                {input.length > 0 && (
                    <div className="grid gap-1">
                        <span className="font-medium text-copy-tertiary">Request</span>
                        <pre className="overflow-x-auto rounded-lg bg-black/[0.035] p-2 whitespace-pre-wrap">
                            {input}
                        </pre>
                    </div>
                )}
                {output.length > 0 && (
                    <div className="overflow-hidden rounded-lg bg-black/[0.035]">
                        <HighlightedCode code={response?.text ?? output} language={languageForPath(title)} />
                    </div>
                )}
            </div>
        </details>
    );
}
