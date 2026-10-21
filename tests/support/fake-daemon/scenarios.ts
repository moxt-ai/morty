import type { HarnessOutput, HarnessReplyPlan } from "@moxt-ai/mobius-test-support/fake-daemon";

const FILE_EXPLORER_SOURCE = [
    "export function FileExplorer() {",
    "    return <aside>Files</aside>;",
    "}",
    ...Array.from(
        { length: 48 },
        (_, index) => `export const explorerRow${index.toString()} = "File ${index.toString()}";`,
    ),
    "export const fileExplorerEnd = true;",
    "",
].join("\n");

export const mortyFiles = new Map<string, { readonly content: string | Uint8Array; readonly mediaType: string }>([
    [
        "/workspace/generated-picture.png",
        {
            content: Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV4kAAAAASUVORK5CYII=",
                "base64",
            ),
            mediaType: "image/png",
        },
    ],
    [
        "/workspace/edit-tool-presentation.tsx",
        {
            content: FILE_EXPLORER_SOURCE,
            mediaType: "text/typescript",
        },
    ],
]);

function manySessionEvents(completion?: string): HarnessReplyPlan {
    return {
        outcome: "complete",
        output: [
            ...Array.from(
                { length: 40 },
                (_, index): HarnessOutput => ({
                    activityType: "reasoning",
                    kind: "activity",
                    output: `Reasoning step ${index.toString().padStart(3, "0")}.`,
                    title: "Thinking",
                }),
            ),
            ...Array.from(
                { length: 20 },
                (_, index): HarnessOutput => ({
                    activityType: "tool",
                    content: [],
                    kind: "activity",
                    output: `Tool result ${index.toString()}`,
                    title: `Inspect item ${index.toString()}`,
                }),
            ),
            ...Array.from(
                { length: 20 },
                (_, index): HarnessOutput => ({
                    kind: "text",
                    text: `Answer part ${index.toString().padStart(3, "0")}.`,
                }),
            ),
            ...(completion === undefined ? [] : [{ kind: "text" as const, text: completion }]),
        ],
    };
}

/** Shared Morty scenario data; the protocol peer has no prompt-specific branches. */
export function mortyReply(prompt: string, turnNumber: number, mode: "prompt" | "steer"): HarnessReplyPlan {
    if (mode === "steer") {
        return {
            outcome: prompt === "Use the revised requirement" ? "hold" : "complete",
            output: [{ kind: "text", text: `Steered: ${prompt}` }],
        };
    }
    const eventBurstPrefix = "many session events: ";
    if (prompt.startsWith(eventBurstPrefix)) {
        return manySessionEvents(`Completed ${prompt.slice(eventBurstPrefix.length)}`);
    }
    switch (prompt) {
        case "fail this turn explicitly":
            throw new Error("The controlled Agent rejected this turn.");
        case "draw a deployment diagram":
            return {
                outcome: "hold",
                output: [
                    { kind: "text", text: "```mermaid\nflowchart LR\n    Browser --> Worker\n    Worker --> Agent\n" },
                ],
            };
        case "draw a sequence diagram":
            return {
                outcome: "hold",
                output: [
                    {
                        kind: "text",
                        text: "```mermaid\nsequenceDiagram\n    Client->>Server: Send request\n    Server-->>Client: Return response\n```\n\nRequest sequence.",
                    },
                ],
            };
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
                        content: [],
                        title: "Read package metadata",
                        output: "Package metadata response",
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
                    { kind: "message", text: "Auto-merge is armed on the rebased head." },
                    { kind: "message", text: "Policy, title, and Worker-config checks are green." },
                    { kind: "message", text: "Static checks are green now; only the test job remains." },
                ],
            };
        case "separate reasoning paragraphs":
            return {
                outcome: "complete",
                output: [
                    "**Inspecting** the reported behavior.\n- keep this literal",
                    "`Checking` the message boundaries.",
                ].map(
                    (output): HarnessOutput => ({
                        activityType: "reasoning",
                        kind: "activity",
                        output,
                        title: "Thinking",
                    }),
                ),
            };
        case "distinguish agent work":
            return {
                outcome: "complete",
                output: [
                    {
                        activityType: "reasoning",
                        kind: "activity",
                        output: "Inspecting the request before acting.",
                        title: "Thinking",
                    },
                    {
                        activityType: "tool",
                        content: [],
                        kind: "activity",
                        output: "Workspace is ready.",
                        title: "Inspect workspace",
                    },
                    { kind: "text", text: "The requested update is complete." },
                ],
            };
        case "long reasoning":
            return {
                outcome: "complete",
                output: [
                    {
                        activityType: "reasoning",
                        kind: "activity",
                        output: `REASONING START OMITTED ${"x".repeat(9_000)}`,
                        title: "Thinking",
                    },
                    {
                        activityType: "reasoning",
                        kind: "activity",
                        output: `${"y".repeat(9_000)} REASONING END RETAINED`,
                        title: "Thinking",
                    },
                ],
            };
        case "many session events":
            return manySessionEvents();
        case "show generated picture":
            return {
                outcome: "complete",
                output: [{ kind: "text", text: "![Generated picture](file:///workspace/generated-picture.png)" }],
            };
        case "generate an image":
            return {
                outcome: "complete",
                output: [
                    {
                        kind: "activity",
                        activityType: "tool",
                        content: [
                            {
                                type: "content",
                                content: {
                                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV4kAAAAASUVORK5CYII=",
                                    mimeType: "image/png",
                                    type: "image",
                                },
                            },
                        ],
                        title: "Generate image",
                        output: "null",
                    },
                ],
            };
        case "view an image":
            return {
                outcome: "complete",
                output: [
                    {
                        kind: "activity",
                        activityType: "tool",
                        content: [
                            {
                                type: "content",
                                content: {
                                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV4kAAAAASUVORK5CYII=",
                                    mimeType: "image/png",
                                    type: "image",
                                },
                            },
                        ],
                        title: "View image",
                        output: "image/png",
                    },
                ],
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
                        content: [],
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
                        content: [
                            {
                                newText: "export const status = 'after';\n",
                                oldText: "export const status = 'before';\n",
                                path: "/workspace/app.js",
                                type: "diff",
                            },
                        ],
                        title: "/workspace/app.js, /workspace/index.html, /workspace/styles.css",
                        output: JSON.stringify({
                            changes: ["/workspace/app.js", "/workspace/index.html", "/workspace/styles.css"],
                        }),
                    },
                ],
            };
        case "show generic file edit":
            return {
                outcome: "complete",
                output: [
                    {
                        kind: "activity",
                        activityType: "tool",
                        content: [
                            {
                                newText: "body { color: green; }\n",
                                oldText: "",
                                path: "/workspace/style.css",
                                type: "diff",
                            },
                        ],
                        title: "Write /workspace/style.css",
                        output: "File created successfully at: /workspace/style.css",
                    },
                ],
            };
        case "show pi file tools":
            return {
                outcome: "complete",
                output: [
                    {
                        kind: "activity",
                        activityType: "tool",
                        content: [],
                        title: "write",
                        output: JSON.stringify({
                            role: "toolResult",
                            toolCallId: "call_write",
                            toolName: "write",
                            content: [
                                {
                                    type: "text",
                                    text: "Successfully wrote to /workspace/package.json",
                                },
                            ],
                            isError: false,
                            durationMs: 8,
                            timestamp: 1_791_946_673_971,
                        }),
                    },
                    {
                        kind: "activity",
                        activityType: "tool",
                        content: [],
                        title: "edit",
                        output: JSON.stringify({
                            role: "toolResult",
                            toolCallId: "call_edit",
                            toolName: "edit",
                            content: [
                                {
                                    type: "text",
                                    text: "Successfully replaced 1 block(s) in /workspace/src/view.js.",
                                },
                            ],
                            details: {
                                diff: " 1 const before = true;\n-2 const status = 'before';\n+2 const status = 'after';",
                                patch: "--- /workspace/src/view.js\n+++ /workspace/src/view.js",
                                firstChangedLine: 2,
                            },
                            isError: false,
                            durationMs: 6,
                            timestamp: 1_791_946_727_966,
                        }),
                    },
                ],
            };
        case "change one file with a rich diff summary":
            return {
                outcome: "complete",
                output: [
                    {
                        kind: "activity",
                        activityType: "tool",
                        content: [
                            {
                                newText: "export const status = 'after';\n",
                                oldText: "export const status = 'before';\n",
                                path: "/workspace/app.js",
                                type: "diff",
                            },
                        ],
                        title: "/workspace/app.js",
                        output: JSON.stringify({ changes: ["/workspace/app.js"] }),
                    },
                ],
            };
        case "change one file with duplicate diffs":
            return {
                outcome: "complete",
                output: [
                    {
                        kind: "activity",
                        activityType: "tool",
                        content: [
                            {
                                newText: "export const status = 'after';\n",
                                oldText: "export const status = 'before';\n",
                                path: "/workspace/app.js",
                                type: "diff",
                            },
                        ],
                        title: "/workspace/app.js",
                        output: JSON.stringify([
                            {
                                newText: "export const status = 'after';\n",
                                oldText: "export const status = 'before';\n",
                                path: "/workspace/app.js",
                                type: "diff",
                            },
                        ]),
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
                        content: [],
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
                        content: [],
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
                        content: [],
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
                        content: [],
                        title: '/bin/zsh -lc "pnpm test"',
                        output: JSON.stringify({
                            exitCode: 0,
                            output: "\u001B[31mfailed\u001B[0m\n\u001B[1;32mpassed\u001B[0m",
                        }),
                    },
                ],
            };
        case "Use the Agent generated title":
            return {
                outcome: "complete",
                output: [
                    { kind: "session-title", title: "Agent generated title" },
                    { kind: "text", text: "The Agent generated a concise title." },
                ],
            };
        case "show huge tool outputs": {
            const middle = "MIDDLE_SHOULD_NOT_RENDER";
            const output = `BEGIN_TOOL_OUTPUT\n${"x".repeat(24_000)}${middle}${"y".repeat(24_000)}\nEND_TOOL_OUTPUT`;
            return {
                outcome: "complete",
                output: [
                    {
                        kind: "activity",
                        activityType: "tool",
                        content: [],
                        title: "Huge diagnostic",
                        output,
                    },
                    {
                        kind: "activity",
                        activityType: "tool",
                        content: [{ type: "content", content: { type: "text", text: output } }],
                        title: '/bin/zsh -lc "huge-output"',
                        output: JSON.stringify({ exitCode: 0, output: "fallback" }),
                    },
                ],
            };
        }
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
                        content: [],
                        title: "Read package metadata",
                        output: "Read package metadata",
                    },
                    { kind: "text", text: `Codex turn ${turnNumber}: ${prompt}` },
                ],
            };
    }
}
