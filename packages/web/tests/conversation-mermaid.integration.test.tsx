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

test.each([
    ["a preceding paragraph", "Overview\n\n```mermaid\nflowchart LR\nBrowser --> Worker"],
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
