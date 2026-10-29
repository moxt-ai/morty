import { fireEvent, getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

test("Given two idle viewers with drafts and attachments, When both submit before receiving live updates, Then the rejected message can be explicitly edited and queued", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Open a shared conversation");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((message) => message.textContent?.includes("Open a shared conversation")),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    const viewer = await app.openViewer();
    const participants: {
        readonly app: TestApp;
        readonly composer: HTMLTextAreaElement;
        readonly fileName: string;
        readonly form: HTMLFormElement;
        readonly prompt: string;
    }[] = [];
    for (const [current, prompt, fileName] of [
        [app, "hold after first delta", "first.json"],
        [viewer, "wait for steering", "second.json"],
    ] as const) {
        const composer = await current.queryElementByTestId(
            dataTestId.messageComposer,
            (element) => element instanceof HTMLTextAreaElement && !element.disabled,
        );
        if (!(composer instanceof HTMLTextAreaElement) || composer.form === null) {
            throw new Error("Expected the message composer form");
        }
        const form = composer.form;
        await current.user.clear(composer);
        await current.user.click(composer);
        await current.user.paste(prompt);
        await current.user.upload(
            getByLabelText(form, "Choose attachments"),
            new File([prompt], fileName, { type: "text/plain" }),
        );
        await current.waitForView(() =>
            expect(getByRole(form, "list", { name: "Attachments" }).textContent).toContain(fileName),
        );
        // Draft editing is available while the live subscription is still loading.
        // Both devices must be able to send before exercising simultaneous submissions.
        await current.waitForView(() => {
            const send = getByRole(form, "button", { name: "Send message" });
            expect(send instanceof HTMLButtonElement && !send.disabled).toBe(true);
        });
        participants.push({ app: current, composer, fileName, form, prompt });
    }
    // Submit both visible forms in the same browser event turn, before either
    // viewer can observe the daemon's new active turn.
    act(() => {
        for (const participant of participants) {
            fireEvent.submit(participant.form);
        }
    });
    const rejected = await app.waitForView(() => {
        const participant = participants.find(({ app: viewer }) =>
            viewer
                .elementsByTestId(dataTestId.queuedMessage)
                .some((element) => element.textContent?.includes("Another prompt is already running")),
        );
        if (participant === undefined) {
            throw new Error("Waiting for the authoritative concurrent submission rejection");
        }
        return participant;
    });
    await rejected.app.waitForView(() => expect(rejected.composer.disabled).toBe(false));
    expect(rejected.composer.value).toBe("");
    const rejectedMessage = rejected.app
        .elementsByTestId(dataTestId.queuedMessage)
        .find((element) => element.textContent?.includes("Another prompt is already running"));
    if (rejectedMessage === undefined) {
        throw new Error("Expected the retained rejected message");
    }
    await rejected.app.user.click(getByRole(rejectedMessage, "button", { name: "Edit failed message" }));
    expect(rejected.composer.value).toBe(rejected.prompt);
    expect(getByRole(rejected.form, "list", { name: "Attachments" }).textContent).toContain(rejected.fileName);
    for (const participant of participants) {
        await participant.app.queryElementByTestId(dataTestId.sessionStatus);
    }
    await rejected.app.user.clear(rejected.composer);
    await rejected.app.user.paste("Keep the recovered follow-up");
    await rejected.app.user.click(getByRole(rejected.form, "button", { name: "Send message" }));
    for (const participant of participants) {
        await participant.app.queryElementByTestId(
            dataTestId.queuedMessage,
            (element) => element.textContent?.includes("Keep the recovered follow-up") === true,
        );
    }
    expect(rejected.composer.value).toBe("");
    expect(queryByRole(rejected.form, "list", { name: "Attachments" })).toBeNull();
    await rejected.app.user.click(getByRole(rejected.form, "button", { name: "Stop agent output" }));
    for (const participant of participants) {
        await participant.app.waitForView(() =>
            expect(
                participant.app
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((message) => message.textContent?.includes("Keep the recovered follow-up")),
            ).toBe(true),
        );
    }
});

test("Given two attachments in a message, When an attachment is removed while submission begins, Then accepted attachments leave the composer and are not sent again", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await sendPrompt(
        app,
        await app.queryElementByTestId(dataTestId.messageComposer),
        "Open attachment ownership conversation",
    );
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((message) => message.textContent?.includes("Open attachment ownership conversation")),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement) || composer.form === null) {
        throw new Error("Expected composer form");
    }
    const form = composer.form;
    await app.user.click(composer);
    await app.user.paste("Submit both attachments");
    await app.user.upload(getByLabelText(form, "Choose attachments"), [
        new File(["First attachment payload"], "first.json", { type: "text/plain" }),
        new File(["Second attachment payload"], "second.json", { type: "text/plain" }),
    ]);
    await app.waitForView(() =>
        expect(getByRole(form, "list", { name: "Attachments" }).textContent).toContain("second.json"),
    );
    await app.waitForView(() =>
        expect(getByRole(form, "button", { name: "Send message" })).toHaveProperty("disabled", false),
    );
    const remove = getByRole(form, "button", { name: "Remove first.json" });
    act(() => {
        fireEvent.submit(form);
        fireEvent.click(remove);
    });
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((message) => message.textContent?.includes("Submit both attachments")),
        ).toBe(true),
    );
    expect(queryByRole(form, "list", { name: "Attachments" })).toBeNull();
    expect(composer.value).toBe("");
    await sendPrompt(app, composer, "Send next message without attachments");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((message) => message.textContent?.includes("Send next message without attachments")),
        ).toBe(true),
    );
    const messages = app.elementsByTestId(dataTestId.userMessage);
    expect(messages.at(-1)?.textContent).not.toContain("Second attachment payload");
    expect(messages.at(-1)?.textContent).not.toContain("first.json");
    expect(messages.at(-1)?.textContent).not.toContain("second.json");
});
