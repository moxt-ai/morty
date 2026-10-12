import { getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a response contains inline and display LaTeX, When I read it, Then the formulas are typeset with the surrounding Markdown", {
    timeout: 30_000,
}, async () => {
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
        outcome: "complete",
        output: [
            {
                kind: "text",
                text: "Euler's identity is $e^{i\\pi} + 1 = 0$.\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$\n\n## Complete",
            },
        ],
    });

    await app.waitForView(() => {
        expect(document.querySelectorAll("math")).toHaveLength(2);
        expect(getByRole(document.body, "heading", { name: "Complete" })).toBeDefined();
        expect(getByRole(document.body, "textbox", { name: "Message" }).hasAttribute("disabled")).toBe(false);
    });
});
