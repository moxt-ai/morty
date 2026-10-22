import type { AgentDisplayContent } from "@/components/agents/display-content";

export function toolTextContent(content: readonly AgentDisplayContent[]): string | null {
    let text: string | null = null;
    for (const item of content) {
        if (item.type === "text") {
            text = text === null ? item.text : `${text}\n${item.text}`;
        }
    }
    return text === null || text.length === 0 ? null : text;
}

export function toolRichContent(content: readonly AgentDisplayContent[]): readonly AgentDisplayContent[] {
    return content.filter((item) => item.type !== "text");
}
