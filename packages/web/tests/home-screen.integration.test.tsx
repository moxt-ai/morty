import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

test("Given a mobile conversation, When I prepare a home screen shortcut, Then my draft stays intact and the clean entry restores my conversation", {
    timeout: 30_000,
}, async () => {
    const viewport = { height: window.innerHeight, width: window.innerWidth };
    window.happyDOM.setViewport({ height: 844, width: 390 });
    let app: TestApp | null = null;
    try {
        app = await createTestApp({ connectAgent: true });
        const composer = await app.queryElementByTestId(dataTestId.messageComposer);
        await sendPrompt(app, composer, "Continue from my home screen");
        await app.waitForView(() =>
            expect(
                app
                    ?.elementsByTestId(dataTestId.agentResponse)
                    .some((entry) => entry.textContent?.includes("Continue from my home screen")),
            ).toBe(true),
        );
        const conversationUrl = window.location.href;
        const sessionId = new URL(conversationUrl).searchParams.get("sessionId");
        expect(sessionId).not.toBeNull();
        const draftComposer = await app.queryElementByTestId(dataTestId.messageComposer);
        await app.user.click(draftComposer);
        await app.user.paste("Keep this unsent draft");
        await app.user.click(getByRole(document.body, "button", { name: "Open navigation" }));
        const shortcut = getByRole(document.body, "link", { name: /^Add to Home Screen/ });
        if (!(shortcut instanceof HTMLAnchorElement)) {
            throw new Error("Expected the shortcut preparation link");
        }
        const preparationUrl = shortcut.href;
        expect(shortcut.target).toBe("_blank");
        expect(shortcut.rel).toContain("noopener");
        await app.user.click(shortcut);
        expect(window.location.href).toBe(conversationUrl);
        expect(getByRole(document.body, "button", { name: "Open navigation" })).toBeTruthy();
        expect(draftComposer).toHaveProperty("value", "Keep this unsent draft");

        // Enter the linked document through the same page assembly as production.
        window.location.href = preparationUrl;
        app = await app.reload();
        expect(getByRole(document.body, "heading", { name: "Add to Home Screen" })).toBeTruthy();
        expect(window.location.href).toBe(`${app.origin}/`);
        expect(app.optionalElementByTestId(dataTestId.messageComposer)).toBeNull();
        app.remount();
        expect(getByRole(document.body, "heading", { name: "Add to Home Screen" })).toBeTruthy();
        expect(window.location.href).toBe(`${app.origin}/`);

        const open = getByRole(document.body, "link", { name: "Open Morty" });
        if (!(open instanceof HTMLAnchorElement)) {
            throw new Error("Expected the normal Morty entry");
        }
        window.location.href = open.href;
        app = await app.reload();
        await app.queryElementByTestId(dataTestId.messageComposer);
        expect(queryByRole(document.body, "heading", { name: "Add to Home Screen" })).toBeNull();
        await app.waitForView(() =>
            expect(new URL(window.location.href).searchParams.get("sessionId")).toBe(sessionId),
        );
        await app.waitForView(() =>
            expect(
                app
                    ?.elementsByTestId(dataTestId.agentResponse)
                    .some((entry) => entry.textContent?.includes("Continue from my home screen")),
            ).toBe(true),
        );
    } finally {
        await app?.close();
        window.happyDOM.setViewport(viewport);
    }
});
