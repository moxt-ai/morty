import type { HarnessOutput, HarnessReplyPlan } from "@moxt-ai/mobius-test-support/fake-daemon";

export const mortyFiles = new Map([
    ["/workspace/generated-picture.png", { content: "test image bytes", mediaType: "image/png" }],
    [
        "/workspace/edit-tool-presentation.tsx",
        {
            content: "export function FileExplorer() {\n    return <aside>Files</aside>;\n}\n",
            mediaType: "text/typescript",
        },
    ],
]);

/** Shared Morty scenario data; the protocol peer has no prompt-specific branches. */
export function mortyReply(prompt: string, turnNumber: number, mode: "prompt" | "steer"): HarnessReplyPlan {
    if (mode === "steer") {
        return {
            outcome: prompt === "Use the revised requirement" ? "hold" : "complete",
            output: [{ kind: "text", text: `Steered: ${prompt}` }],
        };
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
        case "separate response paragraphs":
            return {
                outcome: "complete",
                output: [
                    { kind: "text", text: "Auto-merge is armed on the rebased head." },
                    { kind: "text", text: "Policy, title, and Worker-config checks are green." },
                    { kind: "text", text: "Static checks are green now; only the test job remains." },
                ],
            };
        case "separate reasoning paragraphs":
            return {
                outcome: "complete",
                output: ["Inspecting the reported behavior.", "Checking the message boundaries."].map(
                    (output): HarnessOutput => ({
                        activityType: "reasoning",
                        kind: "activity",
                        output,
                        title: "Thinking",
                    }),
                ),
            };
        case "show generated picture":
            return {
                outcome: "complete",
                output: [{ kind: "text", text: "![Generated picture](file:///workspace/generated-picture.png)" }],
            };
        case "show source file":
            return {
                outcome: "complete",
                output: [
                    {
                        kind: "text",
                        text: "[Open source](file:///workspace/edit-tool-presentation.tsx)",
                    },
                ],
            };
        case "show live output in order":
            return {
                outcome: "complete",
                output: [
                    { kind: "text", text: "First live message" },
                    {
                        kind: "activity",
                        activityType: "tool",
                        title: "Later live tool",
                        output: "Later live tool output",
                    },
                    { kind: "text", text: "Final live message" },
                ],
            };
        case "change several files":
            return {
                outcome: "complete",
                output: [
                    {
                        kind: "activity",
                        activityType: "tool",
                        title: "/workspace/app.js, /workspace/index.html, /workspace/styles.css",
                        output: JSON.stringify({
                            changes: ["/workspace/app.js", "/workspace/index.html", "/workspace/styles.css"],
                        }),
                    },
                ],
            };
        case "inspect browser surfaces":
            return {
                outcome: "complete",
                output: [
                    {
                        kind: "activity",
                        activityType: "tool",
                        title: "cua_repl/js",
                        output: JSON.stringify({
                            content: [
                                {
                                    type: "text",
                                    text: "js execution timed out; kernel reset, rerun your request",
                                },
                            ],
                            structuredContent: null,
                            _meta: {
                                browser_use: {},
                                "codex/browserUse": true,
                                "codex/toolSurface": {
                                    backend: "chrome",
                                    browserFamily: "chrome",
                                    browserId: "1",
                                    kind: "browserUse",
                                },
                            },
                        }),
                    },
                    {
                        kind: "activity",
                        activityType: "tool",
                        title: "cua_repl/js",
                        output: "null",
                    },
                ],
            };
        case "run a quiet shell command":
            return {
                outcome: "complete",
                output: [
                    {
                        kind: "activity",
                        activityType: "tool",
                        title: '/bin/zsh -lc "true"',
                        output: JSON.stringify({ exitCode: 0, output: "" }),
                    },
                ],
            };
        case "run a colorful shell command":
            return {
                outcome: "complete",
                output: [
                    {
                        kind: "activity",
                        activityType: "tool",
                        title: '/bin/zsh -lc "pnpm test"',
                        output: JSON.stringify({
                            exitCode: 0,
                            output: "\u001B[31mfailed\u001B[0m\n\u001B[1;32mpassed\u001B[0m",
                        }),
                    },
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
