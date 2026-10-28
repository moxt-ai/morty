import * as v from "valibot";
import type { AgentDisplayContent } from "@/components/agents/display-content";
import type { SessionToolPresentation } from "@/components/chat/tools/tool-contract";
import { isOversizedToolText } from "./tool-text.ts";

const cwdRequestSchema = v.pipe(
    v.strictObject({
        command: v.pipe(v.string(), v.minLength(1)),
        cwd: v.optional(v.string()),
        description: v.optional(v.string()),
    }),
    v.readonly(),
);
const cwdFormattedResponseSchema = v.pipe(
    v.strictObject({
        exit_code: v.optional(v.number()),
        formatted_output: v.string(),
    }),
    v.readonly(),
);
const cwdOutputResponseSchema = v.pipe(
    v.strictObject({
        exitCode: v.optional(v.number()),
        output: v.string(),
    }),
    v.readonly(),
);
const workdirRequestSchema = v.pipe(
    v.strictObject({
        command: v.pipe(v.string(), v.minLength(1)),
        description: v.optional(v.string()),
        timeout: v.optional(v.number()),
        workdir: v.optional(v.string()),
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

function textContent(content: readonly AgentDisplayContent[]): string | null {
    const parts = content.flatMap((item) => (item.type === "text" ? [item.text] : []));
    return parts.length === 0 ? null : parts.join("\n");
}

function matchesCwdShellCommandToolCall({ input, output }: SessionToolPresentation): boolean {
    return (
        v.safeParse(cwdRequestSchema, parseJson(input)).success ||
        (!isOversizedToolText(output) && v.safeParse(cwdOutputResponseSchema, parseJson(output)).success)
    );
}

function matchesWorkdirShellCommandToolCall({ input }: SessionToolPresentation): boolean {
    return v.safeParse(workdirRequestSchema, parseJson(input)).success;
}

export function isShellCommandToolCall(entry: SessionToolPresentation): boolean {
    return matchesCwdShellCommandToolCall(entry) || matchesWorkdirShellCommandToolCall(entry);
}

/** Returns exactly the terminal text that the Shell renderer makes copyable. */
export function shellCommandOutput(entry: SessionToolPresentation): string | null {
    const display = textContent(entry.content);
    if (display !== null) {
        return isOversizedToolText(display) ? null : display;
    }
    if (isOversizedToolText(entry.output)) {
        return null;
    }
    const response = v.safeParse(
        v.union([cwdFormattedResponseSchema, cwdOutputResponseSchema]),
        parseJson(entry.output),
    );
    if (!response.success) {
        return entry.output;
    }
    return ("output" in response.output ? response.output.output : response.output.formatted_output).trimEnd();
}
