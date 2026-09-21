import { Search } from "lucide-react";
import * as v from "valibot";
import type { ToolCallState } from "../../services/chat/agent-reply.ts";
import { ToolCallStatus, useToolCallDisclosure } from "./tool-call-status.tsx";

const patternSchema = v.pipe(v.string(), v.minLength(1));
const grepRequestSchema = v.pipe(
    v.strictObject({
        caseSensitive: v.optional(v.boolean()),
        include: v.optional(v.string()),
        limit: v.optional(v.number()),
        literal: v.optional(v.boolean()),
        path: v.optional(v.string()),
        pattern: patternSchema,
    }),
    v.readonly(),
);
const globRequestSchema = v.pipe(
    v.strictObject({
        hidden: v.optional(v.boolean()),
        limit: v.optional(v.number()),
        path: v.optional(v.string()),
        pattern: patternSchema,
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

export function matchesSearchToolCall(input: string): boolean {
    const decoded = parseJson(input);
    return v.safeParse(grepRequestSchema, decoded).success || v.safeParse(globRequestSchema, decoded).success;
}

export function SearchToolCall({
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
    const disclosure = useToolCallDisclosure(autoOpen);
    return (
        <details aria-label={`Search: ${title}`} className="group/tool min-w-0" ref={disclosure}>
            <summary
                className="flex min-h-8 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                title={title}
            >
                <Search aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{title}</span>
                <ToolCallStatus state={state} />
            </summary>
            <div className="mt-1 ml-5 grid min-w-0 gap-2 text-xs">
                {input.length > 0 && (
                    <div className="grid gap-1">
                        <span className="font-medium text-copy-tertiary">Request</span>
                        <pre className="max-h-40 overflow-auto rounded-lg bg-black/[0.035] p-2 whitespace-pre-wrap">
                            {input}
                        </pre>
                    </div>
                )}
                {output.length > 0 && (
                    <div className="grid gap-1">
                        <span className="font-medium text-copy-tertiary">Results</span>
                        <pre className="max-h-96 overflow-auto rounded-lg bg-black/[0.035] p-2 whitespace-pre-wrap">
                            {output}
                        </pre>
                    </div>
                )}
            </div>
        </details>
    );
}
