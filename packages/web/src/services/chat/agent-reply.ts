import type { MobiusAgentActivityEvent, MobiusAttemptSummary } from "@moxt-ai/mobius-sdk";

export type ReplyPhase = "working" | "waiting" | "completed" | "cancelled" | "failed" | "interrupted";

type ReasoningThinkingEntry = {
    readonly id: string;
    readonly kind: "reasoning";
    readonly text: string;
    readonly status: "streaming" | "recorded";
};

export type NoticeThinkingEntry = {
    readonly id: string;
    readonly kind: "notice";
    readonly severity: "error" | "warning";
    readonly text: string;
};

export type ToolThinkingEntry = {
    readonly content: MobiusAgentActivityEvent["content"];
    readonly id: string;
    readonly input: string;
    readonly kind: "tool";
    readonly name: string;
    readonly output: string;
    readonly state: ToolCallState;
    readonly title: string;
};

export type ToolCallState =
    | { readonly kind: "running" }
    | { readonly kind: "succeeded" }
    | { readonly kind: "failed" }
    | { readonly kind: "unknown" };

export type ThinkingEntry = NoticeThinkingEntry | ReasoningThinkingEntry | ToolThinkingEntry;

export interface ThinkingPresentation {
    readonly autoOpen: boolean;
    readonly entries: readonly ThinkingEntry[];
}

function toolCallState(status: string): ToolCallState {
    switch (status) {
        case "pending":
        case "running":
            return { kind: "running" };
        case "completed":
            return { kind: "succeeded" };
        case "failed":
            return { kind: "failed" };
        default:
            return { kind: "unknown" };
    }
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
    stepsActive: boolean,
): { readonly phase: ReplyPhase; readonly thinking: ThinkingPresentation } {
    const phase = replyPhase(attempt, active);
    const entries = activities.flatMap((activity): readonly ThinkingEntry[] => {
        const status = stepsActive && activity.status === "running" ? "streaming" : "recorded";
        if (activity.activityType === "notice") {
            return activity.output.length === 0
                ? []
                : [
                      {
                          id: activity.activityId,
                          kind: "notice",
                          severity: activity.status === "failed" ? "error" : "warning",
                          text: activity.output,
                      },
                  ];
        }
        if (activity.activityType === "reasoning" || activity.activityType === "progress") {
            return activity.output.length === 0
                ? []
                : [{ id: activity.activityId, kind: "reasoning", status, text: activity.output }];
        }
        if (activity.activityType !== "tool") {
            return [];
        }
        if (phase === "waiting" && activity.output.length === 0) {
            return [];
        }
        return [
            {
                content: activity.content,
                id: activity.activityId,
                input: activity.input,
                kind: "tool",
                name: activity.name,
                output: activity.output,
                state: toolCallState(activity.status),
                title: activity.title || activity.name || activity.toolKind || "Tool call",
            },
        ];
    });
    return { phase, thinking: { autoOpen: stepsActive, entries } };
}
