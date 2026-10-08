import { BookOpen } from "lucide-react";
import * as v from "valibot";
import { ToolCallStatus, useToolCallDisclosure } from "./tool-call-status.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

const inputSchema = v.pipe(
    v.strictObject({
        args: v.string(),
        skill: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
);

function parseInput(value: string): v.InferOutput<typeof inputSchema> | null {
    try {
        const decoded: unknown = JSON.parse(value);
        const input = v.safeParse(inputSchema, decoded);
        return input.success ? input.output : null;
    } catch {
        return null;
    }
}

export function matchesSkillToolCall({ input }: ToolRendererProps["entry"]): boolean {
    return parseInput(input) !== null;
}

export function SkillToolCall({ autoOpen, entry }: ToolRendererProps) {
    const input = parseInput(entry.input);
    const disclosure = useToolCallDisclosure(autoOpen);
    if (input === null) {
        return null;
    }
    const title = `Load skill: ${input.skill}`;
    return (
        <details aria-label={`Skill: ${input.skill}`} className="group/tool min-w-0" ref={disclosure}>
            <summary
                className="flex min-h-8 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                title={title}
            >
                <BookOpen aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{title}</span>
                <ToolCallStatus state={entry.state} />
            </summary>
            {input.args.length > 0 && (
                <div className="mt-1 ml-5 max-h-96 overflow-auto rounded-lg bg-black/[0.035] p-2 text-xs whitespace-pre-wrap">
                    {input.args}
                </div>
            )}
        </details>
    );
}
