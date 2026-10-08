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
    await app.waitForView(() => {
        expect(getAllByText(thinking, "Thinking")).toHaveLength(1);
        expect(thinking.querySelectorAll("p")).toHaveLength(2);
        expect(thinking.textContent).toContain("Inspecting the reported behavior.");
        expect(thinking.textContent).toContain("Checking the message boundaries.");
    });
});

test("Given a file-change tool reports its changed-file schema, When the user opens it, Then Chat presents the changed files as an edit", {
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
    if (!(shellTool instanceof HTMLDetailsElement)) {
        throw new Error("Expected the shell tool to use a disclosure");
    }
    expect(shellTool.open).toBe(false);
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
    const thinking = await app.waitForView(() => {
        const match = app
            .elementsByTestId(dataTestId.agentReasoning)
            .find((element) => element.textContent?.includes("Inspecting the workspace") === true);
        if (match === undefined) {
            throw new Error(`Reasoning is unavailable: ${document.body.textContent}`);
        }
        return match;
    });
    if (!(thinking instanceof HTMLDetailsElement)) {
        throw new Error("Expected reasoning to use a disclosure");
    }
    expect(thinking.open).toBe(true);
    expect(thinking.textContent).toContain("Show intermediate steps");
    expect(thinking.textContent).toContain("Thinking");
    await app.waitForView(() => expect(document.body.textContent).toContain("Read package metadata"));
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
    expect(getByRole(document.body, "log", { name: "Messages" }).textContent).not.toContain("test image bytes");
    app.remount();
    const restored = await app.waitForView(() => getByRole(document.body, "img", { name: "Generated picture" }));
    expect(restored.getAttribute("src")).toMatch(/^blob:/u);
});
