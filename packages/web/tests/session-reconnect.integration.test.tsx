import { queryByRole } from "@testing-library/dom";
import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

function reconnectStatusText(app: TestApp): string | null {
    const notice = app.optionalElementByTestId(dataTestId.sessionReconnectNotice);
    if (notice === null) {
        return null;
    }
    return queryByRole(notice, "status")?.textContent ?? null;
}

test("Given a session whose Runtime goes offline, When the live event stream cannot recover, Then the pane shows the failure with a retry countdown, reconnects automatically, and shows the failure with a retry time again", {
    timeout: 90_000,
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
    const prompt = "Survive a Runtime restart";
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected the connected Agent Runtime");
    }
    await daemon.disconnect();

    const countdown = /^Retrying in [1-9]\d* s Retry now$/u;
    await vi.waitFor(() => expect(reconnectStatusText(app)).toMatch(countdown), { interval: 250, timeout: 30_000 });
    const notice = app.elementByTestId(dataTestId.sessionReconnectNotice);
    const composerForm = notice.closest("form");
    if (composerForm === null) {
        throw new Error("Expected the retry status beside the composer");
    }
    expect(queryByRole(composerForm, "alert")?.textContent).toContain("could not recover");
    expect(composerForm.textContent).toMatch(/could not recover[\s\S]*Retrying in [1-9]\d* s Retry now/u);
    const retryNow = queryByRole(notice, "button", { name: "Retry now" });
    if (!(retryNow instanceof HTMLButtonElement)) {
        throw new Error("Expected the Retry now button");
    }
    await app.user.click(retryNow);

    await vi.waitFor(() => expect(reconnectStatusText(app)).toContain("Mobius is reconnecting"), {
        interval: 250,
        timeout: 30_000,
    });

    await vi.waitFor(() => expect(reconnectStatusText(app)).toMatch(countdown), { interval: 250, timeout: 30_000 });
});

async function openSavedConversation(app: TestApp, prompt: string): Promise<HTMLTextAreaElement> {
    const draft = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(draft instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the draft composer");
    }
    await sendPrompt(app, draft, prompt);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((message) => message.textContent?.includes(`Codex turn 1: ${prompt}`)),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const saved = await app.waitForView(() => {
        const conversation = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((candidate) => candidate.textContent?.includes(prompt));
        if (conversation === undefined) {
            throw new Error("Waiting for the saved conversation");
        }
        return conversation;
    });
    await app.user.click(saved);
    await app.waitForView(() =>
        expect(queryByRole(document.body, "heading", { level: 2, name: prompt })).not.toBeNull(),
    );
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the saved conversation composer");
    }
    return composer;
}

test("Given a disconnected conversation with an unsent draft, When the same Runtime reconnects twice, Then its connection error clears without sending and the draft remains", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await openSavedConversation(app, "Before the Runtime restart");
    if (app.daemon === null) {
        throw new Error("Expected a connected Runtime");
    }
    await app.user.click(composer);
    await app.user.paste("Keep this unsent draft");
    const form = composer.closest("form");
    if (form === null) {
        throw new Error("Expected the composer form");
    }
    for (const cycle of [1, 2]) {
        await app.daemon.disconnect();
        await app.waitForView(
            () =>
                expect(reconnectStatusText(app), document.body.textContent ?? `disconnect ${cycle}`).toContain(
                    "Retrying in",
                ),
            30_000,
        );
        expect(queryByRole(form, "alert")?.textContent).toContain("could not recover");
        expect(composer.disabled).toBe(true);
        await app.daemon.reconnect();
        const retry = queryByRole(form, "button", { name: "Retry now" });
        if (!(retry instanceof HTMLButtonElement)) {
            throw new Error("Expected manual reconnect control");
        }
        await app.user.click(retry);
        await app.waitForView(() => {
            expect(composer.disabled, `recovery ${cycle}`).toBe(false);
            expect(reconnectStatusText(app)).toBeNull();
        });
        expect(queryByRole(form, "alert")).toBeNull();
        expect(composer.value).toBe("Keep this unsent draft");
    }
    await app.user.clear(composer);
    await sendPrompt(app, composer, "After the Runtime restart");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((message) => message.textContent?.includes("Codex turn 2: After the Runtime restart")),
        ).toBe(true),
    );
});

test("Given a failed Agent turn, When its Runtime disconnects and reconnects, Then the unrelated turn error remains visible", {
    timeout: 90_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const composer = await openSavedConversation(app, "Before the failed turn");
    if (app.daemon === null) {
        throw new Error("Expected a connected Runtime");
    }
    const form = composer.closest("form");
    if (form === null) {
        throw new Error("Expected the composer form");
    }
    await sendPrompt(app, composer, "fail this turn explicitly");
    await app.waitForView(() =>
        expect(queryByRole(form, "alert")?.textContent, document.body.textContent ?? "").toContain(
            "The controlled Agent rejected this turn.",
        ),
    );
    await app.daemon.disconnect();
    await app.waitForView(
        () => expect(reconnectStatusText(app), document.body.textContent ?? "").toContain("Retrying in"),
        30_000,
    );
    await app.daemon.reconnect();
    const retry = queryByRole(form, "button", { name: "Retry now" });
    if (!(retry instanceof HTMLButtonElement)) {
        throw new Error("Expected manual reconnect control");
    }
    await app.user.click(retry);
    await app.waitForView(() => {
        expect(composer.disabled).toBe(false);
        expect(reconnectStatusText(app)).toBeNull();
    });
    expect(queryByRole(form, "alert")?.textContent).toContain("The controlled Agent rejected this turn.");
});
