import type { ReactNode } from "react";
import type { ToolThinkingEntry } from "../../services/chat/agent-reply.ts";
import { EditTool, matchesEditTool } from "./edit-tool.tsx";
import { matchesReadTool, ReadTool } from "./read-tool.tsx";
import { matchesShellCommandToolCall, ShellCommandToolCall } from "./shell-command-tool-call.tsx";

interface ToolRenderer {
    readonly matches: (entry: ToolThinkingEntry) => boolean;
    readonly render: (entry: ToolThinkingEntry, autoOpen: boolean) => ReactNode;
}

const TOOL_RENDERERS: readonly ToolRenderer[] = [
    {
        matches: (entry) => matchesEditTool(entry.input, entry.output),
        render: (entry, autoOpen) => (
            <EditTool
                autoOpen={autoOpen}
                content={entry.content}
                input={entry.input}
                output={entry.output}
                state={entry.state}
                title={entry.title}
            />
        ),
    },
    {
        matches: (entry) => matchesShellCommandToolCall(entry.input),
        render: (entry, autoOpen) => (
            <ShellCommandToolCall autoOpen={autoOpen} output={entry.output} state={entry.state} title={entry.title} />
        ),
    },
    {
        matches: (entry) => matchesReadTool(entry.output),
        render: (entry, autoOpen) => (
            <ReadTool
                autoOpen={autoOpen}
                input={entry.input}
                output={entry.output}
                state={entry.state}
                title={entry.title}
            />
        ),
    },
];

export function renderRegisteredTool(entry: ToolThinkingEntry, autoOpen: boolean): ReactNode | null {
    return TOOL_RENDERERS.find((renderer) => renderer.matches(entry))?.render(entry, autoOpen) ?? null;
}
