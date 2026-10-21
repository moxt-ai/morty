import { getAllByTestId, getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a message contains generic types and HTML, When I send it and reload, Then both sides preserve the literal text", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, page: { kind: "bootstrap", identity: true } });
    const prompt = "Compare Vec<String> and Option<T>. Mention <placeholder> and <div>x</div> literally.";
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), prompt);

    const assertMessages = () => {
        for (const message of getAllByTestId(document.body, dataTestId.userMessage)) {
            expect(message.textContent).toContain(prompt);
        }
        expect(getByRole(document.body, "article", { name: "Agent response" }).textContent).toContain(prompt);
    };
    await app.waitForView(assertMessages);
    const reloaded = await app.reload();
    await reloaded.waitForView(assertMessages);
});

test("Given streamed HTML examples, When the response grows and completes, Then tags remain inert text alongside Markdown", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a controlled Agent Runtime");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "hold after first delta");
    await app.waitForView(() => expect(document.body.textContent).toContain("Partial reply"));
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: "\n\nUse Vec<Str" }],
    });
    await app.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain("Use Vec<Str"),
    );
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: "ing> and <placeholder" }],
    });
    await app.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Use Vec<String> and <placeholder",
        ),
    );
    const html =
        '<div>Literal **HTML**</div>\n<script>window.literalHtmlExecuted = true</script>\n<button onclick="window.literalHtmlExecuted = true">Run example</button>';
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: `> literally.\n\n${html}\n\nGenerics: Vec<String>.` }],
    });
    const assertLiteralHtml = () => {
        const response = getByRole(document.body, "log", { name: "Messages" });
        expect(response.textContent).toContain("Use Vec<String> and <placeholder> literally.");
        expect(response.textContent).toContain(html);
        expect(response.textContent).toContain("Vec<String>");
        expect(queryByRole(response, "button", { name: "Run example" })).toBeNull();
        expect(response.querySelector("script")).toBeNull();
    };
    await app.waitForView(assertLiteralHtml);
    await daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [
            {
                kind: "text",
                text: "\n\n## Explanation\n\nInline `Option<T>` and **bold text**.\n\n```html\n<div>code</div>\n```\n\n<https://example.com>",
            },
        ],
    });
    await app.waitForView(() => {
        assertLiteralHtml();
        const response = getByRole(document.body, "log", { name: "Messages" });
        expect(getByRole(response, "heading", { name: "Explanation" })).toBeDefined();
        expect(response.textContent).toContain("Option<T>");
        expect(response.textContent).toContain("<div>code</div>");
        expect(getByRole(response, "link", { name: "https://example.com" }).getAttribute("href")).toBe(
            "https://example.com/",
        );
    });
});
