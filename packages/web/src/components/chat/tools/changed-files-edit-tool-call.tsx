import * as v from "valibot";
import { AgentRichContent } from "../../agents/agent-rich-content.tsx";
import { EditToolPresentation } from "./edit-tool-presentation.tsx";
import { toolRichContent } from "./tool-display-content.ts";
import type { ToolRendererProps } from "./tool-renderer.ts";

const changesSchema = v.pipe(
    v.strictObject({
        changes: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1), v.readonly()),
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

function parseChanges(entry: ToolRendererProps["entry"]): v.InferOutput<typeof changesSchema> | null {
    for (const candidate of [entry.input, entry.output]) {
        const parsed = v.safeParse(changesSchema, parseJson(candidate));
        if (parsed.success) {
            return parsed.output;
        }
    }
    return null;
}

export function matchesChangedFilesEditToolCall(entry: ToolRendererProps["entry"]): boolean {
    return parseChanges(entry) !== null;
}

export function ChangedFilesEditToolCall({ autoOpen, entry }: ToolRendererProps) {
    const changes = parseChanges(entry);
    if (changes === null) {
        return null;
    }
    return (
        <EditToolPresentation autoOpen={autoOpen} entry={entry}>
            <ul aria-label="Changed files" className="grid gap-1">
                {changes.changes.map((path, index) => (
                    <li
                        className="truncate font-mono text-copy-secondary"
                        key={`${path}:${index.toString()}`}
                        title={path}
                    >
                        {path}
                    </li>
                ))}
            </ul>
            <AgentRichContent contents={toolRichContent(entry.content)} />
        </EditToolPresentation>
    );
}
