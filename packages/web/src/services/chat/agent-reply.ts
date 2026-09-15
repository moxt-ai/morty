import type { MobiusAgentActivityEvent, MobiusAttemptSummary } from "@moxt-ai/mobius-sdk";

export type ReplyPhase = "working" | "waiting" | "completed" | "cancelled" | "failed" | "interrupted";

interface ThinkingEntry {
    readonly id: string;
    readonly text: string;
    readonly status: "streaming" | "recorded";
}

export interface ThinkingPresentation {
    readonly entries: readonly ThinkingEntry[];
    readonly status: "thinking" | "working" | "idle";
}

function replyPhase(attempt: MobiusAttemptSummary | null, active: boolean): ReplyPhase {
    if (attempt === null) {
        return active ? "working" : "completed";
    }
    switch (attempt.kind) {
        case "none":
        case "dispatching":
        case "running":
            return active ? "working" : "interrupted";
        case "waiting_input":
            return "waiting";
        case "succeeded":
            return "completed";
        case "cancelled":
            return "cancelled";
        case "failed":
            return "failed";
        default:
            return "interrupted";
    }
}

export function describeAgentReply(
    attempt: MobiusAttemptSummary | null,
    activities: readonly MobiusAgentActivityEvent[],
    active: boolean,
): { readonly phase: ReplyPhase; readonly thinking: ThinkingPresentation } {
    const phase = replyPhase(attempt, active);
    const reasoning = activities.filter((activity) => activity.activityType === "reasoning");
    const entries = reasoning
        .filter((activity) => activity.output.length > 0)
        .map(
            (activity): ThinkingEntry => ({
                id: activity.activityId,
                text: activity.output,
                status: phase === "working" && activity.status === "running" ? "streaming" : "recorded",
            }),
        );
    let status: ThinkingPresentation["status"] = "idle";
    if (phase === "working") {
        status = reasoning.some((activity) => activity.status === "running" || activity.status === "pending")
            ? "thinking"
            : "working";
    }
    return { phase, thinking: { entries, status } };
}
