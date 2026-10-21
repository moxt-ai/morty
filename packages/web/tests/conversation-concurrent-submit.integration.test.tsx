import { fireEvent, getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

test("Given two idle viewers with drafts and attachments, When both submit before receiving live updates, Then the rejected draft remains editable and can be queued", {
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
        const participant = participants.find(({ form }) =>
            queryByRole(form, "alert")?.textContent?.includes("Another prompt is already running"),
        );
        if (participant === undefined) {
            throw new Error("Waiting for the authoritative concurrent submission rejection");
        }
        return participant;
    });
    await rejected.app.waitForView(() => expect(rejected.composer.disabled).toBe(false));
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
