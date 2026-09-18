import type { MobiusAgentActivityEvent, MobiusAttemptSummary } from "@moxt-ai/mobius-sdk";

export type ReplyPhase = "working" | "waiting" | "completed" | "cancelled" | "failed" | "interrupted";

type ThinkingEntry =
    | {
          readonly id: string;
          readonly kind: "reasoning";
          readonly text: string;
          readonly status: "streaming" | "recorded";
      }
    | {
          readonly id: string;
          readonly input: string;
          readonly kind: "tool";
          readonly output: string;
          readonly status: "streaming" | "recorded";
          readonly title: string;
      };

export interface ThinkingPresentation {
    readonly entries: readonly ThinkingEntry[];
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
    latest: boolean,
): { readonly phase: ReplyPhase; readonly thinking: ThinkingPresentation } {
    const phase = replyPhase(attempt, active);
    const entries = activities.flatMap((activity): readonly ThinkingEntry[] => {
        const status = phase === "working" && latest && activity.status === "running" ? "streaming" : "recorded";
        if (activity.activityType === "reasoning") {
            return activity.output.length === 0
                ? []
                : [{ id: activity.activityId, kind: "reasoning", status, text: activity.output }];
        }
        if (activity.activityType !== "tool") {
            return [];
        }
        return [
            {
                id: activity.activityId,
                input: activity.input,
                kind: "tool",
                output: activity.output,
                status,
                title: activity.title || activity.name || activity.toolKind || "Tool call",
            },
        ];
    });
    return { phase, thinking: { entries } };
}
