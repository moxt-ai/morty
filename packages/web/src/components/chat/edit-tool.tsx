import type { AgentDisplayContent } from "@moxt-ai/mobius-sdk";
import { FileDiff } from "lucide-react";
import * as v from "valibot";
import type { ToolCallState } from "../../services/chat/agent-reply.ts";
import { AgentRichContent } from "../agents/agent-rich-content.tsx";
import { HighlightedCode, languageForPath } from "./highlighted-code.tsx";
import { ToolCallStatus, useToolCallDisclosure } from "./tool-call-status.tsx";

const diffSchema = v.pipe(
    v.array(
        v.object({
            newText: v.nullable(v.string()),
            oldText: v.nullable(v.string()),
            path: v.pipe(v.string(), v.minLength(1)),
            type: v.literal("diff"),
        }),
    ),
    v.readonly(),
);
const patchSchema = v.pipe(
    v.strictObject({
        patchText: v.pipe(v.string(), v.minLength(1)),
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

function parseDiffs(value: string) {
    const result = v.safeParse(diffSchema, parseJson(value));
    return result.success ? result.output : null;
}

function parsePatch(value: string): string | null {
    const result = v.safeParse(patchSchema, parseJson(value));
    return result.success ? result.output.patchText : null;
}

export function matchesEditTool(input: string, output: string): boolean {
    return parseDiffs(input) !== null || parseDiffs(output) !== null || parsePatch(input) !== null;
}

export function EditTool({
    autoOpen,
    content,
    input,
    output,
    state,
    title,
}: {
    readonly autoOpen: boolean;
    readonly content: readonly AgentDisplayContent[];
    readonly input: string;
    readonly output: string;
    readonly state: ToolCallState;
    readonly title: string;
}) {
    const diffs = parseDiffs(input) ?? parseDiffs(output);
    const patch = parsePatch(input);
    const disclosure = useToolCallDisclosure(autoOpen);
    return (
        <details aria-label={`Edit: ${title}`} className="group/tool min-w-0" ref={disclosure}>
            <summary
                className="flex min-h-8 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                title={title}
            >
                <FileDiff aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{title}</span>
                <ToolCallStatus state={state} />
            </summary>
            <div className="mt-1 ml-5 grid min-w-0 gap-2 text-xs">
                {diffs !== null ? (
                    diffs.map((diff) => (
                        <section className="min-w-0 overflow-hidden rounded-lg border border-black/7" key={diff.path}>
                            <div className="truncate border-b border-black/7 bg-black/[0.025] px-2.5 py-1.5 font-mono text-copy-secondary">
                                {diff.path}
                            </div>
                            <div className="grid max-h-96 overflow-auto font-mono text-[11px] leading-[18px] md:grid-cols-2">
                                <div className="min-w-0 bg-[#fff4f2] text-[#8f2f35]">
                                    <HighlightedCode code={diff.oldText ?? ""} language={languageForPath(diff.path)} />
                                </div>
                                <div className="min-w-0 bg-[#effaf4] text-[#17663f]">
                                    <HighlightedCode code={diff.newText ?? ""} language={languageForPath(diff.path)} />
                                </div>
                            </div>
                        </section>
                    ))
                ) : patch !== null ? (
                    <div className="overflow-hidden rounded-lg border border-black/7 bg-black/[0.025]">
                        <HighlightedCode code={patch} language="diff" />
                    </div>
                ) : content.length > 0 ? (
                    <AgentRichContent contents={content} />
                ) : (
                    <pre className="overflow-x-auto rounded-lg bg-black/[0.035] p-2 whitespace-pre-wrap">
                        {output || input}
                    </pre>
                )}
            </div>
        </details>
    );
}
