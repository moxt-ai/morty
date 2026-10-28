import type { AgentThinkingEntry } from "../../components/chat/agent-thinking.tsx";
import { isFileEditToolCall } from "../../components/chat/tools/tool-renderer-registry.tsx";
import type { TurnWorkSummary } from "../../components/chat/turn-work-disclosure.tsx";

function operationLabel(operation: string | null | undefined): string {
    switch (operation) {
        case "read":
            return "Reading files";
        case "edit":
            return "Editing files";
        case "delete":
            return "Removing files";
        case "move":
            return "Moving files";
        case "search":
            return "Searching";
        case "execute":
            return "Running commands";
        case "fetch":
            return "Fetching information";
        case "think":
            return "Thinking";
        default:
            return "Running tools";
    }
}

export function executionSummary(
    entries: readonly AgentThinkingEntry[],
    active: boolean,
    finished: boolean,
    waitingFor: "permission" | "answer" | null = null,
): TurnWorkSummary {
    const tools = entries.filter((entry) => entry.kind === "tool");
    const running = tools.filter((entry) => entry.state.kind === "running");
    const failed = tools.filter(
        (entry) =>
            entry.state.kind === "failed" || (entry.state.kind === "background" && entry.state.status === "failed"),
    ).length;
    const interrupted = tools.filter(
        (entry) =>
            entry.state.kind === "interrupted" ||
            (entry.state.kind === "background" && entry.state.status === "stopped"),
    ).length;
    const backgroundRunning = tools.filter(
        (entry) => entry.state.kind === "background" && entry.state.status === "running",
    ).length;
    const backgroundUnknown = tools.filter(
        (entry) => entry.state.kind === "background" && entry.state.status === "unknown",
    ).length;
    const unknown = tools.some((entry) => entry.state.kind === "unknown");
    const current = running.at(-1);
    // Categories come from the protocol, never inferred from command strings.
    // A successful call is not evidence that the user's overall task succeeded.
    let phase: string;
    if (waitingFor !== null) {
        phase = waitingFor === "permission" ? "Waiting for confirmation" : "Waiting for your answer";
    } else if (running.length > 1) {
        phase = `Running ${running.length} tools`;
    } else if (current !== undefined) {
        phase = operationLabel(current.operation);
    } else if (active) {
        phase = entries.at(-1)?.kind === "reasoning" ? "Thinking" : operationLabel(tools.at(-1)?.operation);
    } else if (failed > 0) {
        phase = "Needs attention";
    } else if (backgroundRunning > 0) {
        phase = "Running in background";
    } else if (interrupted > 0) {
        phase = "Execution interrupted";
    } else if (backgroundUnknown > 0 || unknown) {
        phase = "Status unknown";
    } else {
        phase = finished ? "Operations complete" : "Execution details";
    }
    return {
        backgroundRunning,
        backgroundUnknown,
        failed,
        interrupted,
        fileEdits: tools.filter(isFileEditToolCall).length,
        phase,
        steps: tools.length,
        tone:
            waitingFor !== null
                ? "waiting"
                : failed > 0 || interrupted > 0 || backgroundUnknown > 0 || unknown
                  ? "attention"
                  : active || running.length > 0 || backgroundRunning > 0
                    ? "working"
                    : "settled",
    };
}
