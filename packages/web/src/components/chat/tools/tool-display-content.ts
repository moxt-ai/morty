import type { AgentDisplayContent } from "@moxt-ai/mobius-sdk";

export function toolTextContent(content: readonly AgentDisplayContent[]): string | null {
    const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
    return text.length > 0 ? text : null;
}

export function toolRichContent(content: readonly AgentDisplayContent[]): readonly AgentDisplayContent[] {
    return content.filter((item) => item.type !== "text");
}
