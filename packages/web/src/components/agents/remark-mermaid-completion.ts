export const INCOMPLETE_MERMAID_META = "morty-incomplete-mermaid";

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function offset(position: unknown, edge: "start" | "end"): number | null {
    if (!record(position)) {
        return null;
    }
    const point = position[edge];
    if (!record(point)) {
        return null;
    }
    const value = point["offset"];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function incompleteFence(node: Record<string, unknown>, source: string): boolean {
    const start = offset(node["position"], "start");
    const end = offset(node["position"], "end");
    const code = node["value"];
    if (start === null || end === null || end < start || end > source.length || typeof code !== "string") {
        return false;
    }
    if (source.slice(end).trim().length > 0) {
        return false;
    }
    const lines = source.slice(start, end).split(/\r\n|\r|\n/u);
    const opening = lines[0]?.match(/^[ \t]*(`{3,}|~{3,})/u)?.[1];
    const closing = lines.at(-1)?.match(/(`{3,}|~{3,})[ \t]*$/u)?.[1];
    const contentLines = code.length === 0 ? 0 : code.split(/\r\n|\r|\n/u).length;
    // The parser removes real opening/closing fences from `value`, but retains
    // fence-like lines inside the code. Line counts also work in quotes and lists.
    const closed =
        opening !== undefined &&
        closing !== undefined &&
        opening[0] === closing[0] &&
        closing.length >= opening.length &&
        lines.length >= contentLines + 2;
    return !closed;
}

function markMermaidFences(value: unknown, source: string, streaming: boolean): void {
    if (!record(value)) {
        return;
    }
    if (value["type"] === "code" && value["lang"] === "mermaid") {
        // Replace user metastrings so they cannot claim a fence's completion state.
        value["meta"] = streaming && incompleteFence(value, source) ? INCOMPLETE_MERMAID_META : null;
    }
    if (Array.isArray(value["children"])) {
        for (const child of value["children"]) {
            markMermaidFences(child, source, streaming);
        }
    }
}

export function remarkMermaidCompletion({ streaming }: { readonly streaming: boolean }) {
    return (tree: unknown, file: { readonly value: unknown }): void => {
        if (typeof file.value === "string") {
            markMermaidFences(tree, file.value, streaming);
        }
    };
}
