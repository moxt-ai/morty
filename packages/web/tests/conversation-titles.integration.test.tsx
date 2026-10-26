import { getByRole, queryByRole } from "@testing-library/dom";
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

test("Given a saved title differs from the native session listing, When reopening Chat and selecting it in Open Session, Then the listing and preview use the recent session title", {
    timeout: 30_000,
}, async () => {
    const title = "Agent generated title";
    const app = await createTestApp({ connectAgent: true, nativeSessionIds: new Set(["title-review"]) });
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: "Open Session" })));
    const initialDialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    await app.user.click(
        await app.waitForView(() => getByRole(initialDialog, "button", { name: "Native title-review" })),
    );
    await app.waitForView(() => getByRole(initialDialog, "heading", { name: "Native title-review" }));
    await app.user.click(getByRole(initialDialog, "button", { name: "Open" }));
    await app.waitForView(() => expect(queryByRole(document.body, "dialog", { name: "Open Session" })).toBeNull());
    await app.waitForView(() => getByRole(document.body, "heading", { name: "Native title-review" }));
    await sendPrompt(app, await readyComposer(app), "Use the Agent generated title");
    await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "The Agent generated a concise title.",
        );
        expect(getByRole(document.body, "heading", { name: title })).toBeDefined();
    });

    const reopened = await app.reload();
    await reopened.waitForView(() => expect(directoryTitles(reopened).some((item) => item.includes(title))).toBe(true));
    await reopened.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const dialog = await reopened.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
    const entry = await reopened.waitForView(() => getByRole(dialog, "button", { name: title }));
    await reopened.user.click(entry);
    const preview = getByRole(dialog, "region", { name: "Selected session preview" });
    await reopened.waitForView(() => getByRole(preview, "heading", { name: title }));

    await reopened.user.click(getByRole(dialog, "button", { name: "Close dialog" }));
    await reopened.waitForView(() => expect(queryByRole(document.body, "dialog", { name: "Open Session" })).toBeNull());
    await reopened.user.click(await reopened.waitForView(() => getByRole(document.body, "button", { name: title })));
    const input = getByRole(document.body, "textbox", { name: "Conversation title" });
    await reopened.user.clear(input);
    await reopened.user.type(input, "My renamed session");
    await reopened.user.click(getByRole(document.body, "button", { name: "Save title" }));
    await reopened.waitForView(() => getByRole(document.body, "heading", { name: "My renamed session" }));
    await reopened.user.click(getByRole(document.body, "button", { name: "Open Session" }));
    const renamedDialog = await reopened.waitForView(() =>
        getByRole(document.body, "dialog", { name: "Open Session" }),
    );
    await reopened.user.click(
        await reopened.waitForView(() => getByRole(renamedDialog, "button", { name: "My renamed session" })),
    );
    await reopened.waitForView(() => getByRole(renamedDialog, "heading", { name: "My renamed session" }));
});
