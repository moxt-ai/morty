import type { ReplyPlan } from "@moxt-ai/mobius-test/fake-daemon/model";

/** Shared Morty scenario data; the protocol peer has no prompt-specific branches. */
export function mortyReply(prompt: string, turnNumber: number, mode: "prompt" | "steer"): ReplyPlan {
    if (mode === "steer") {
        return { outcome: "complete", output: [{ kind: "text", text: `Steered: ${prompt}` }] };
    }
    switch (prompt) {
        case "hold with rich content":
            return {
                outcome: "hold",
                output: [
                    {
                        kind: "activity",
                        activityType: "reasoning",
                        title: "Thinking",
                        output: "Inspecting the workspace",
                    },
                    {
                        kind: "activity",
                        activityType: "tool",
                        title: "Read package metadata",
                        output: "Read package metadata",
                    },
                    { kind: "text", text: "Partial rich reply" },
                ],
            };
        case "wait for steering":
            return { outcome: "hold", output: [{ kind: "text", text: "Waiting for steering" }] };
        case "hold after first delta":
            return {
                outcome: "hold",
                output: [
                    { kind: "text", text: "Partial reply" },
                    { kind: "file", name: "partial.bin" },
                ],
            };
        case "hold after large output":
            return {
                outcome: "hold",
                output: [
                    { kind: "file", name: "long-output.bin" },
                    ...Array.from({ length: 3 }, () => ({ kind: "text" as const, text: "x".repeat(100_000) })),
                ],
            };
        default:
            return {
                outcome: "complete",
                output: [
                    {
                        kind: "activity",
                        activityType: "reasoning",
                        title: "Thinking",
                        output: "Inspecting the workspace",
                    },
                    {
                        kind: "activity",
                        activityType: "tool",
                        title: "Read package metadata",
                        output: "Read package metadata",
                    },
                    { kind: "text", text: `Codex turn ${turnNumber}: ${prompt}` },
                ],
            };
    }
}
