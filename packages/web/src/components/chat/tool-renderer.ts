import type { ToolThinkingEntry } from "../../services/chat/agent-reply.ts";

export interface ToolRendererProps {
    readonly autoOpen: boolean;
    readonly entry: ToolThinkingEntry;
}
