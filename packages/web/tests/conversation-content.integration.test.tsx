import { getAllByRole, getAllByText, getByRole, getByText, queryByText } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given the agent sends separate adjacent messages, When the user reads the response, Then each message starts a new paragraph", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "separate response paragraphs");
    await app.waitForView(() => {
        const responses = app.elementsByTestId(dataTestId.agentResponse);
        expect(responses.map((response) => response.textContent)).toEqual([
            "Auto-merge is armed on the rebased head.",
            "Policy, title, and Worker-config checks are green.",
            "Static checks are green now; only the test job remains.",
        ]);
    });
});

test("Given the agent sends separate reasoning messages, When the user reads the intermediate steps, Then they form paragraphs in one thinking block", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "separate reasoning paragraphs");
    const thinking = await app.queryElementByTestId(dataTestId.agentReasoning);
    await app.user.click(getByText(thinking, "Show intermediate steps"));
    await app.waitForView(() => {
        expect(thinking.textContent).toContain("**Inspecting** the reported behavior.\n- keep this literal");
        expect(thinking.textContent).toContain("`Checking` the message boundaries.");
    });
    expect(thinking.querySelector("strong")).toBeNull();
    expect(thinking.querySelector("code")).toBeNull();
});

test("Given the agent sends many session events, When the response completes, Then every event type remains usable without mounting collapsed reasoning", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "many session events");
    const thinking = await app.queryElementByTestId(dataTestId.agentReasoning);
    if (!(thinking instanceof HTMLDetailsElement)) {
        throw new Error("Expected reasoning to use a disclosure");
    }
    await app.waitForView(() => {
        expect(thinking.open).toBe(false);
        expect(document.body.textContent).toContain("Inspect item 19");
        expect(document.body.textContent).toContain("Answer part 019.");
    });
    expect(document.body.textContent).not.toContain("Reasoning step 000.");
    expect(document.body.textContent).not.toContain("Reasoning step 039.");

    await app.user.click(getByText(thinking, "Show intermediate steps"));
    await app.waitForView(() => {
        expect(document.body.textContent).toContain("Reasoning step 000.");
        expect(document.body.textContent).toContain("Reasoning step 039.");
    });
});

test("Given a file-change tool includes a rich diff, When the user views it, Then the complete edit stays collapsed until opened", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "change several files");

    const edit = await app.waitForView(() =>
        getByRole(document.body, "group", {
            name: "Edit: /workspace/app.js, /workspace/index.html, /workspace/styles.css",
        }),
    );
    const editDisclosure = getByRole(edit, "button", {
        name: "/workspace/app.js, /workspace/index.html, /workspace/styles.css Tool succeeded",
    });
    expect(editDisclosure.getAttribute("aria-expanded")).toBe("false");
    expect(queryByText(document.body, "/workspace/app.js", { exact: true })).toBeNull();
    await app.user.click(editDisclosure);
    expect(editDisclosure.getAttribute("aria-expanded")).toBe("true");
    expect(getAllByText(document.body, "/workspace/app.js", { exact: true }).length).toBeGreaterThan(0);
    expect(getByRole(edit, "list", { name: "Changed files" }).textContent).toBe(
        "/workspace/app.js/workspace/index.html/workspace/styles.css",
    );
    expect(queryByText(edit, "Request")).toBeNull();
    expect(queryByText(edit, "Response")).toBeNull();
});

test("Given a browser tool reports its tool-result schema, When the user opens it, Then Chat presents the browser output without protocol metadata", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "inspect browser surfaces");

    const browserTools = await app.waitForView(() => {
        const tools = getAllByRole(document.body, "group", { name: "Browser: cua_repl/js" });
        expect(tools).toHaveLength(2);
        return tools;
    });
    const [timedOutTool, successfulTool] = browserTools;
    if (timedOutTool === undefined || successfulTool === undefined) {
        throw new Error("Expected two browser tools");
    }
    expect(timedOutTool.textContent).not.toContain("js execution timed out; kernel reset, rerun your request");
    expect(successfulTool.textContent).not.toContain("null");
    await app.user.click(getByRole(timedOutTool, "button"));
    await app.user.click(getByRole(successfulTool, "button"));
    expect(timedOutTool.textContent).toContain("js execution timed out; kernel reset, rerun your request");
    expect(timedOutTool.textContent).not.toContain("structuredContent");
    expect(timedOutTool.textContent).not.toContain("codex/toolSurface");
    expect(queryByText(timedOutTool, "Request")).toBeNull();
    expect(queryByText(timedOutTool, "Response")).toBeNull();
    expect(successfulTool.textContent).not.toContain("null");
});

test("Given a shell tool completes, When the user views the conversation, Then the tool stays collapsed", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "run a quiet shell command");

    const shellTool = await app.waitForView(() =>
        getByRole(document.body, "group", { name: 'Shell command: /bin/zsh -lc "true"' }),
    );
    expect(getByRole(shellTool, "button").getAttribute("aria-expanded")).toBe("false");
    expect(shellTool.textContent).not.toContain('{"exitCode":0,"output":""}');
    expect(queryByText(shellTool, "Response")).toBeNull();
});

test("Given a response links to a TypeScript file, When the user opens it, Then the source is syntax highlighted beside the conversation", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "show source file");
    await app.user.click(await app.queryElementByTestId(dataTestId.localFileLink));
    const preview = await app.queryElementByTestId(dataTestId.filePreview);
    const content = await app.queryElementByTestId(dataTestId.filePreviewContent);
    expect(preview.parentElement?.querySelector('[role="log"][aria-label="Messages"]')).not.toBeNull();
    expect(content.textContent).toContain("export function FileExplorer");
    await app.waitForView(() => expect(content.querySelector('code span[style*="--sdm-c"]')).not.toBeNull());
});

test("Given shell output contains ANSI styles, When the user opens it, Then Chat presents terminal colors and emphasis without escape sequences", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "run a colorful shell command");

    const shellTool = await app.waitForView(() =>
        getByRole(document.body, "group", { name: 'Shell command: /bin/zsh -lc "pnpm test"' }),
    );
    await app.user.click(getByText(shellTool, '/bin/zsh -lc "pnpm test"'));
    const output = app.elementByTestId(dataTestId.ansiShellOutput, shellTool);
    expect(output.textContent).toBe("failed\npassed");
    expect(output.textContent).not.toContain("\u001B");
    const failed = Array.from(output.querySelectorAll("span")).find((element) => element.textContent === "failed");
    const passed = Array.from(output.querySelectorAll("span")).find((element) => element.textContent === "passed");
    expect(failed?.style.color).not.toBe("");
    expect(passed?.style.color).not.toBe("");
    expect(passed?.style.fontWeight).toBe("bold");
});

test("Given tool results exceed 32 KiB, When the user opens them, Then Chat renders bounded plain-text previews", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "show huge tool outputs");

    const genericTool = await app.waitForView(() =>
        getByRole(document.body, "group", { name: "Tool: Huge diagnostic" }),
    );
    const shellTool = await app.waitForView(() =>
        getByRole(document.body, "group", {
            name: 'Shell command: /bin/zsh -lc "huge-output"',
        }),
    );
    await app.user.click(getByRole(genericTool, "button"));
    await app.user.click(getByRole(shellTool, "button"));

    for (const tool of [genericTool, shellTool]) {
        expect(tool.textContent).toContain("BEGIN_TOOL_OUTPUT");
        expect(tool.textContent).toContain("END_TOOL_OUTPUT");
        expect(tool.textContent).toContain("characters omitted");
        expect(tool.textContent).not.toContain("MIDDLE_SHOULD_NOT_RENDER");
        expect(getByRole(tool, "button", { name: "Load more output" })).toBeDefined();
    }
    expect(shellTool.querySelector(`[data-testid="${dataTestId.ansiShellOutput}"]`)).toBeNull();
    expect(queryByText(shellTool, "Request")).toBeNull();
    expect(queryByText(shellTool, "Response")).toBeNull();
    await app.user.click(getByRole(genericTool, "button", { name: "Load more output" }));
    expect(genericTool.textContent).toContain("MIDDLE_SHOULD_NOT_RENDER");
    expect(queryByText(genericTool, "Load more output")).toBeNull();
});

test("Given the daemon emits reasoning, a tool, and text, When the user observes and stops an unfinished turn, Then partial content is visible before completion and survives remount", {
    timeout: 30_000,
}, async () => {
    const prompt = "hold with rich content";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    const thinking = await app.queryElementByTestId(dataTestId.agentReasoning);
    if (!(thinking instanceof HTMLDetailsElement)) {
        throw new Error("Expected reasoning to use a disclosure");
    }
    if (!thinking.open) {
        await app.user.click(getByText(thinking, "Show intermediate steps"));
    }
    await app.waitForView(() => expect(thinking.textContent).toContain("Inspecting the workspace"));
    expect(thinking.open).toBe(true);
    expect(thinking.textContent).toContain("Show intermediate steps");
    await app.waitForView(() => expect(document.body.textContent).toContain("Read package metadata"));
    const genericTool = await app.queryElementByTestId(dataTestId.agentToolCall);
    expect(getByRole(genericTool, "button").getAttribute("aria-expanded")).toBe("false");
    expect(genericTool.textContent).not.toContain("Package metadata response");
    await app.waitForView(() => {
        const restored = app
            .elementsByTestId(dataTestId.agentResponse)
            .some((element) => element.textContent?.includes("Partial rich reply") === true);
        if (!restored) {
            throw new Error(`The restored response is unavailable: ${document.body.textContent}`);
        }
    });
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    app.remount();
    const restoredThinking = await app.queryElementByTestId(dataTestId.agentReasoning);
    if (!(restoredThinking instanceof HTMLDetailsElement)) {
        throw new Error("Expected restored reasoning to use a disclosure");
    }
    await app.waitForView(() => expect(restoredThinking.open).toBe(false));
    await app.waitForView(() => {
        const restored = app
            .elementsByTestId(dataTestId.agentResponse)
            .some((element) => element.textContent?.includes("Partial rich reply") === true);
        if (!restored) {
            throw new Error(`The restored response is unavailable: ${document.body.textContent}`);
        }
    });
    await app.waitForView(() => expect(document.body.textContent).toContain("Read package metadata"));
});

test("Given an Agent response references a local image, When the user reads it and reopens the conversation, Then the image is fetched through Runtime and remains visible without base64 text", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "show generated picture");
    const image = await app.waitForView(() => getByRole(document.body, "img", { name: "Generated picture" }));
    expect(image.getAttribute("src")).toMatch(/^blob:/u);
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("iVBORw0KGgo");
    app.remount();
    const restored = await app.waitForView(() => getByRole(document.body, "img", { name: "Generated picture" }));
    expect(restored.getAttribute("src")).toMatch(/^blob:/u);
});

test("Given Codex generates an image, When the user opens the tool, Then Chat shows the image without raw protocol fields", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }

    await sendPrompt(app, composer, "generate an image");

    const imageTool = await app.waitForView(() => getByRole(document.body, "group", { name: "Tool: Generate image" }));
    const disclosure = getByRole(imageTool, "button", { name: "Generate image Tool succeeded" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    await app.user.click(disclosure);
    const image = await app.waitForView(() => getByRole(imageTool, "img", { name: "Image" }));
    expect(image.getAttribute("src")).toMatch(/^blob:/u);
    expect(imageTool.textContent).not.toContain("Request");
    expect(imageTool.textContent).not.toContain("Response");
    expect(imageTool.textContent).not.toContain("null");
    expect(imageTool.textContent).not.toContain("iVBORw0KGgo");
});
