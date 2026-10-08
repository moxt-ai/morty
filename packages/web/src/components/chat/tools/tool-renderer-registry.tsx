import type { ComponentType, ReactNode } from "react";
import { ChangedFilesEditToolCall, matchesChangedFilesEditToolCall } from "./changed-files-edit-tool-call.tsx";
import { CwdShellCommandToolCall, matchesCwdShellCommandToolCall } from "./cwd-shell-command-tool-call.tsx";
import { FilePathEditToolCall, matchesFilePathEditToolCall } from "./file-path-edit-tool-call.tsx";
import { FilePathReadToolCall, matchesFilePathReadToolCall } from "./file-path-read-tool-call.tsx";
import { GlobToolCall, matchesGlobToolCall } from "./glob-tool-call.tsx";
import { GrepToolCall, matchesGrepToolCall } from "./grep-tool-call.tsx";
import { InputDiffEditToolCall, matchesInputDiffEditToolCall } from "./input-diff-edit-tool-call.tsx";
import { matchesOutputDiffEditToolCall, OutputDiffEditToolCall } from "./output-diff-edit-tool-call.tsx";
import { matchesPatchEditToolCall, PatchEditToolCall } from "./patch-edit-tool-call.tsx";
import { matchesPathReadToolCall, PathReadToolCall } from "./path-read-tool-call.tsx";
import { matchesQuestionToolCall, QuestionToolCall } from "./question-tool-call.tsx";
import { matchesSkillToolCall, SkillToolCall } from "./skill-tool-call.tsx";
import type { ToolRendererProps, ToolThinkingEntry } from "./tool-renderer.ts";
import { matchesWorkdirShellCommandToolCall, WorkdirShellCommandToolCall } from "./workdir-shell-command-tool-call.tsx";

interface ToolRenderer {
    readonly Component: ComponentType<ToolRendererProps>;
    readonly matches: (entry: ToolThinkingEntry) => boolean;
}

const TOOL_RENDERERS: readonly ToolRenderer[] = [
    {
        Component: QuestionToolCall,
        matches: matchesQuestionToolCall,
    },
    {
        Component: SkillToolCall,
        matches: matchesSkillToolCall,
    },
    {
        Component: ChangedFilesEditToolCall,
        matches: matchesChangedFilesEditToolCall,
    },
    {
        Component: FilePathEditToolCall,
        matches: matchesFilePathEditToolCall,
    },
    {
        Component: InputDiffEditToolCall,
        matches: matchesInputDiffEditToolCall,
    },
    {
        Component: OutputDiffEditToolCall,
        matches: matchesOutputDiffEditToolCall,
    },
    {
        Component: PatchEditToolCall,
        matches: matchesPatchEditToolCall,
    },
    {
        Component: CwdShellCommandToolCall,
        matches: matchesCwdShellCommandToolCall,
    },
    {
        Component: WorkdirShellCommandToolCall,
        matches: matchesWorkdirShellCommandToolCall,
    },
    {
        Component: PathReadToolCall,
        matches: matchesPathReadToolCall,
    },
    {
        Component: FilePathReadToolCall,
        matches: matchesFilePathReadToolCall,
    },
    {
        Component: GrepToolCall,
        matches: matchesGrepToolCall,
    },
    {
        Component: GlobToolCall,
        matches: matchesGlobToolCall,
    },
];

export function renderRegisteredTool(entry: ToolThinkingEntry, autoOpen: boolean): ReactNode | null {
    const renderer = TOOL_RENDERERS.find((candidate) => candidate.matches(entry));
    if (renderer === undefined) {
        return null;
    }
    const Component = renderer.Component;
    return <Component autoOpen={autoOpen} entry={entry} />;
}
