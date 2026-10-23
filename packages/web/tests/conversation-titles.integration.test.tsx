import { queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

async function readyComposer(app: TestApp): Promise<HTMLTextAreaElement> {
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    return composer;
}

function directoryTitles(app: TestApp): readonly string[] {
    return app.elementsByTestId(dataTestId.managedConversation).map((entry) => entry.textContent ?? "");
}

test("Given a conversation this page created, When another client renames it, Then the directory shows the new name once it reloads", {
    timeout: 30_000,
}, async () => {
    const firstPrompt = "Name this conversation from the first prompt";
    const renamed = "Renamed by another client";
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );

    await sendPrompt(app, await readyComposer(app), firstPrompt);
    await app.waitForView(() => {
        expect(queryByRole(document.body, "heading", { level: 2, name: firstPrompt })).not.toBeNull();
        expect(directoryTitles(app).some((title) => title.includes(firstPrompt))).toBe(true);
        // The first-prompt title is optimistic; wait for delivery before leaving
        // so this scenario renames a prompted Session, not an unsent draft.
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((response) => response.textContent?.includes(firstPrompt)),
        ).toBe(true);
    });
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (sessionId === null) {
        throw new Error("The opened conversation must have an address");
    }

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await daemon.renameSession(sessionId, renamed);
    // Starting another conversation reloads the directory.
    await sendPrompt(app, await readyComposer(app), "Start another conversation");

    await app.waitForView(() => {
        const titles = directoryTitles(app);
        expect(titles.some((title) => title.includes("Start another conversation"))).toBe(true);
        expect(titles.some((title) => title.includes(renamed))).toBe(true);
        expect(titles.some((title) => title.includes(firstPrompt))).toBe(false);
    });
});
