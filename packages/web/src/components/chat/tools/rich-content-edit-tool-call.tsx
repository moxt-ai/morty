import { EditToolPresentation } from "./edit-tool-presentation.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

export function matchesRichContentEditToolCall({ content }: ToolRendererProps["entry"]): boolean {
    return content.some((item) => item.type === "diff");
}

export function RichContentEditToolCall({ autoOpen, entry }: ToolRendererProps) {
    return (
        <EditToolPresentation autoOpen={autoOpen} entry={entry}>
            {null}
        </EditToolPresentation>
    );
}
