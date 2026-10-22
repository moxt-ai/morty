import { getByRole, getByText, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

async function replyWithMarkdown(markdown: string, outcome: "hold" | "complete") {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected composer");
    }
    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await daemon.continueReply("hold after first delta", {
        outcome,
        output: [{ kind: "text", text: markdown }],
    });
    return app;
}

function replyWithDiagram(source: string) {
    return replyWithMarkdown(`\`\`\`mermaid\n${source}\n\`\`\`\n\nResponse complete.`, "complete");
}

test("Given an oversized Mermaid diagram, When I read the reply, Then I see its source and can continue the conversation", {
    timeout: 30_000,
}, async () => {
    const source = `flowchart LR\n%% ${"x".repeat(17_000)}\nBrowser --> Worker`;
    const app = await replyWithDiagram(source);
    await app.waitForView(() => {
        expect(document.body.textContent).toContain("Diagram is too large to display.");
        expect(document.body.textContent).toContain("Browser --> Worker");
        expect(document.body.textContent).toContain("Response complete.");
        expect(getByRole(document.body, "button", { name: "Copy code" })).toBeDefined();
        expect(queryByRole(document.body, "img", { name: "Mermaid chart" })).toBeNull();
        expect(getByRole(document.body, "textbox", { name: "Message" }).hasAttribute("disabled")).toBe(false);
    });
});

test("Given an unfinished Mermaid reply, When I read the active conversation, Then the source remains visible while waiting for completion", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected composer");
    }
    await sendPrompt(app, composer, "draw a deployment diagram");
    await app.waitForView(() => {
        expect(document.body.textContent).toContain("Waiting for the diagram to finish…");
        expect(document.body.textContent).toContain("Browser --> Worker");
        expect(queryByRole(document.body, "img", { name: "Mermaid chart" })).toBeNull();
        expect(getByRole(document.body, "button", { name: "Stop agent output" })).toBeDefined();
    });
});

test("Given invalid Mermaid syntax, When I open the diagram, Then a readable failure preserves the original source", {
    timeout: 30_000,
}, async () => {
    const app = await replyWithDiagram("not-a-diagram\nBrowser --> Worker");
    await app.waitForView(() => {
        expect(document.body.textContent).toContain("Response complete.");
        expect(document.body.textContent).not.toContain("Loading diagram…");
    }, 30_000);
    const fullscreen = await app.waitForView(
        () => getByRole(document.body, "button", { name: "View diagram fullscreen" }),
        30_000,
    );
    await app.user.click(fullscreen);
    await app.waitForView(() => expect(document.body.textContent).toContain("Diagram could not be displayed."));
    await app.user.keyboard("{Escape}");
    await app.user.click(getByText(document.body, "View diagram source", { exact: true }));
    expect(document.body.textContent).toContain("not-a-diagram");
    expect(document.body.textContent).toContain("Response complete.");
});

test.each([
    ["a preceding paragraph", "Overview\n\n```mermaid\nflowchart LR\nBrowser --> Worker"],
    ["a blockquote", "> ~~~mermaid\n> flowchart LR\n> Browser --> Worker"],
    ["a list", "- Overview\n\n  ```mermaid\n  flowchart LR\n  Browser --> Worker"],
    ["an indented fence-like code line", "```mermaid\nflowchart LR\nBrowser --> Worker\n    ```"],
])(
    "Given an unfinished diagram in %s, When I read the active reply, Then I see the pending source",
    { timeout: 30_000 },
    async (_description, markdown) => {
        const app = await replyWithMarkdown(markdown, "hold");
        await app.waitForView(() => {
            expect(document.body.textContent).toContain("Waiting for the diagram to finish…");
            expect(document.body.textContent).toContain("Browser --> Worker");
        });
    },
);

test("Given a closed diagram followed by another unfinished diagram, When I read the active reply, Then only the unfinished diagram waits", {
    timeout: 30_000,
}, async () => {
    const app = await replyWithMarkdown(
        "```mermaid morty-incomplete-mermaid\nflowchart LR\nBrowser --> Worker\n```\n\n> ~~~mermaid\n> sequenceDiagram\n> Client->>Server: Request",
        "hold",
    );
    await app.waitForView(() => {
        expect(getByText(document.body, "View diagram source", { exact: true })).toBeDefined();
        expect(getByText(document.body, "Waiting for the diagram to finish…", { exact: true })).toBeDefined();
        expect(document.body.textContent).toContain("Client->>Server: Request");
    });
});
