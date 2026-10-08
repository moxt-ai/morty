import type { SessionToolPresentation } from "../../../view-models/chat/session-presentation.ts";

export type ToolCallState = SessionToolPresentation["state"];
export type ToolThinkingEntry = SessionToolPresentation;

export interface ToolRendererProps {
    readonly autoOpen: boolean;
    readonly entry: ToolThinkingEntry;
}
