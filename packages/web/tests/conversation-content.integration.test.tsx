import { getAllByText, getByRole, queryByText } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given the daemon streams split text events, When the user reads the response, Then the chunks form continuous text", {
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
    await sendPrompt(app, composer, "stream split text");
    await app.waitForView(() => {
        const messages = getByRole(document.body, "log", { name: "Messages" }).innerText;
        expect(messages).toContain("Build a dependency-free local app.");
        expect(messages).toContain("npm test");
        expect(messages).not.toContain("```");
        expect(messages).not.toContain("Delivery wasn’t confirmed");
    });
});

test("Given the daemon streams continuous thinking chunks, When the user reads the intermediate steps, Then the chunks form one thinking block", {
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
    await sendPrompt(app, composer, "stream split thinking");
    const thinking = await app.queryElementByTestId(dataTestId.agentReasoning);
    await app.waitForView(() => {
        expect(getAllByText(thinking, "Thinking")).toHaveLength(1);
        expect(thinking.textContent).toContain("The user is showing me an image");
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
