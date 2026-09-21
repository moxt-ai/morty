import { Terminal } from "lucide-react";
import * as v from "valibot";
import type { ToolCallState } from "../../services/chat/agent-reply.ts";
import { HighlightedCode } from "./highlighted-code.tsx";
import { ToolCallStatus, useToolCallDisclosure } from "./tool-call-status.tsx";

interface ShellCommandRequest {
    readonly command: string;
    readonly cwd: string | null;
}

interface ShellCommandResponse {
    readonly output: string;
}

const commandSchema = v.pipe(v.string(), v.minLength(1));
const shellCommandCwdRequestSchema = v.pipe(
    v.strictObject({
        command: commandSchema,
        cwd: v.optional(v.string()),
    }),
    v.readonly(),
);
const shellCommandWorkdirRequestSchema = v.pipe(
    v.strictObject({
        command: commandSchema,
        timeout: v.optional(v.number()),
        workdir: v.optional(v.string()),
    }),
    v.readonly(),
);
const shellCommandResponseSchema = v.pipe(
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

function shellRequest(value: string): ShellCommandRequest | null {
    const decoded = parseJson(value);
    const cwdRequest = v.safeParse(shellCommandCwdRequestSchema, decoded);
    if (cwdRequest.success) {
        return { command: cwdRequest.output.command, cwd: cwdRequest.output.cwd ?? null };
    }
    const workdirRequest = v.safeParse(shellCommandWorkdirRequestSchema, decoded);
    return workdirRequest.success
        ? { command: workdirRequest.output.command, cwd: workdirRequest.output.workdir ?? null }
        : null;
}

function shellResponse(value: string): ShellCommandResponse | null {
    const result = v.safeParse(shellCommandResponseSchema, parseJson(value));
    if (!result.success) {
        return null;
    }
    return { output: result.output.formatted_output.trimEnd() };
}

export function matchesShellCommandToolCall(input: string): boolean {
    return shellRequest(input) !== null;
}

export function ShellCommandToolCall({
    autoOpen,
    output,
    state,
    title,
}: {
    readonly autoOpen: boolean;
    readonly output: string;
    readonly state: ToolCallState;
    readonly title: string;
}) {
    const response = shellResponse(output);
    const disclosure = useToolCallDisclosure(autoOpen);
    return (
        <details aria-label={`Shell command: ${title}`} className="group/tool min-w-0" ref={disclosure}>
            <summary
                className="flex min-h-8 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                title={title}
            >
                <Terminal aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{title}</span>
                <ToolCallStatus state={state} />
            </summary>
            {output.length > 0 && (
                <div className="mt-1 ml-5 overflow-hidden rounded-lg bg-black/[0.035]">
                    <HighlightedCode code={response?.output ?? output} language="bash" />
                </div>
            )}
        </details>
    );
}
