import * as v from "valibot";
import { ShellCommandPresentation } from "./shell-command-presentation.tsx";
import { toolTextContent } from "./tool-display-content.ts";
import type { ToolRendererProps } from "./tool-renderer.ts";

const requestSchema = v.pipe(
    v.strictObject({
        command: v.pipe(v.string(), v.minLength(1)),
        cwd: v.optional(v.string()),
    }),
    v.readonly(),
);
const responseSchema = v.pipe(
    v.strictObject({
        exit_code: v.optional(v.number()),
        formatted_output: v.string(),
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

export function matchesCwdShellCommandToolCall({ input }: ToolRendererProps["entry"]): boolean {
    return v.safeParse(requestSchema, parseJson(input)).success;
}

export function CwdShellCommandToolCall({ autoOpen, entry }: ToolRendererProps) {
    const response = v.safeParse(responseSchema, parseJson(entry.output));
    const output =
        toolTextContent(entry.content) ??
        (response.success ? response.output.formatted_output.trimEnd() : entry.output);
    return <ShellCommandPresentation autoOpen={autoOpen} entry={entry} response={output} />;
}
