import type { Output, ReplyPlan } from "@moxt-ai/mobius-test/fake-daemon/model";

export const mortyFiles = new Map([
    [
        "/workspace/edit-tool-presentation.tsx",
        {
            content: "export function FileExplorer() {\n    return <aside>Files</aside>;\n}\n",
            mediaType: "text/typescript",
        },
    ],
]);

/** Shared Morty scenario data; the protocol peer has no prompt-specific branches. */
export function mortyReply(prompt: string, turnNumber: number, mode: "prompt" | "steer"): ReplyPlan {
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
        case "stream split text":
            return {
                outcome: "complete",
                output: ["Build", " a", " dependency", "-free", " local app.\n\n`", "``sh\nnpm", " test\n``", "`"].map(
                    (text) => ({
                        kind: "text" as const,
                        text,
                    }),
                ),
            };
        case "stream split thinking":
            return {
                outcome: "complete",
                output: ["The ", "user ", "is ", "showing ", "me ", "an ", "image"].map(
                    (output): Output => ({
                        activityType: "reasoning",
                        kind: "activity",
                        output,
                        title: "Thinking",
                    }),
                ),
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
