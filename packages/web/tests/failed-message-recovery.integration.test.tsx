import { fireEvent, getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

interface Participant {
    readonly app: TestApp;
    readonly composer: HTMLTextAreaElement;
    readonly form: HTMLFormElement;
    readonly prompt: string;
}

function answered(app: TestApp, text: string): boolean {
    return app.elementsByTestId(dataTestId.agentResponse).some((element) => element.textContent?.includes(text));
}

function failedMessage(app: TestApp): HTMLElement | undefined {
    return app
        .elementsByTestId(dataTestId.queuedMessage)
        .find((element) => queryByRole(element, "alert")?.textContent?.includes("Another prompt is already running"));
}

async function editableComposer(app: TestApp): Promise<HTMLTextAreaElement> {
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    return composer;
}

/** Two viewers send at once; the Runtime rejects one message, and the accepted turn is then stopped. */
async function rejectConcurrentMessage(rejectedPrompt: string): Promise<Participant> {
    const app = await createTestApp({ connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Open a shared conversation");
    await app.waitForView(() => expect(answered(app, "Open a shared conversation")).toBe(true));
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    const viewer = await app.openViewer();
    const participants: Participant[] = [];
    for (const [current, prompt] of [
        [app, "hold after first delta"],
        [viewer, rejectedPrompt],
    ] as const) {
        const composer = await editableComposer(current);
        if (composer.form === null) {
            throw new Error("Expected the message composer form");
        }
        const form = composer.form;
        await current.user.clear(composer);
        await current.user.click(composer);
        await current.user.paste(prompt);
        await current.waitForView(() =>
            expect(getByRole(form, "button", { name: "Send message" })).toHaveProperty("disabled", false),
        );
        participants.push({ app: current, composer, form, prompt });
    }
    // Submit both forms before either viewer observes the other's turn.
    act(() => {
        for (const participant of participants) {
            fireEvent.submit(participant.form);
        }
    });
    const rejected = await app.waitForView(() => {
        const participant = participants.find((candidate) => failedMessage(candidate.app) !== undefined);
        if (participant === undefined) {
            throw new Error("Waiting for the authoritative concurrent submission rejection");
        }
        return participant;
    });
    const accepted = participants.find((participant) => participant !== rejected);
    if (accepted === undefined) {
        throw new Error("Expected the accepted participant");
    }
    await accepted.app.user.click(
        await accepted.app.waitForView(() => getByRole(accepted.form, "button", { name: "Stop agent output" })),
    );
    await rejected.app.waitForView(() =>
        expect(rejected.app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull(),
    );
    return rejected;
}

test("Given a message the Runtime rejected while another prompt ran, When I retry it after that prompt stops, Then the Agent answers it and my next draft stays", {
    timeout: 60_000,
}, async () => {
    const rejected = await rejectConcurrentMessage("Retry the rejected message");
    await rejected.app.user.click(rejected.composer);
    await rejected.app.user.paste("My next draft");
    const failed = failedMessage(rejected.app);
    if (failed === undefined) {
        throw new Error("Expected the retained rejected message");
    }
    await rejected.app.user.click(
        await rejected.app.waitForView(() => {
            const retry = getByRole(failed, "button", { name: "Retry message" });
            expect(retry).toHaveProperty("disabled", false);
            return retry;
        }),
    );
    await rejected.app.waitForView(() => expect(answered(rejected.app, "Retry the rejected message")).toBe(true));
    expect(failedMessage(rejected.app)).toBeUndefined();
    expect(rejected.composer.value).toBe("My next draft");
});

test("Given a message the Runtime rejected, When I discard it, Then it leaves the conversation and my next draft can be sent", {
    timeout: 60_000,
}, async () => {
    const rejected = await rejectConcurrentMessage("Discard the rejected message");
    await rejected.app.user.click(rejected.composer);
    await rejected.app.user.paste("Send my next draft instead");
    const failed = failedMessage(rejected.app);
    if (failed === undefined) {
        throw new Error("Expected the retained rejected message");
    }
    await rejected.app.user.click(getByRole(failed, "button", { name: "Discard failed message" }));
    expect(failedMessage(rejected.app)).toBeUndefined();
    const send = await rejected.app.waitForView(() => {
        const button = getByRole(rejected.form, "button", { name: "Send message" });
        expect(button).toHaveProperty("disabled", false);
        return button;
    });
    await rejected.app.user.click(send);
    await rejected.app.waitForView(() => expect(answered(rejected.app, "Send my next draft instead")).toBe(true));
    expect(answered(rejected.app, "Discard the rejected message")).toBe(false);
});

test("Given a message the Runtime rejected and a next draft, When the page reloads, Then the rejected text returns to the composer ahead of the draft", {
    timeout: 60_000,
}, async () => {
    const rejected = await rejectConcurrentMessage("Keep the rejected text");
    await rejected.app.user.click(rejected.composer);
    await rejected.app.user.paste("My next draft");
    const reloaded = await rejected.app.reload();
    await reloaded.waitForView(() =>
        expect(reloaded.elementByTestId(dataTestId.messageComposer)).toHaveProperty(
            "value",
            "Keep the rejected text\n\nMy next draft",
        ),
    );
    expect(failedMessage(reloaded)).toBeUndefined();
});

function heldSessionCreation() {
    let gate = Promise.withResolvers<void>();
    let holding = false;
    onTestFinished(() => gate.resolve());
    return {
        hold: () => {
            gate = Promise.withResolvers<void>();
            void gate.promise.catch(() => undefined);
            holding = true;
        },
        release: () => gate.resolve(),
        reject: () => gate.reject(new Error("The controlled Agent could not create a Session")),
        agent: {
            id: "settings-test",
            label: "Settings Agent",
            beforeSessionCreated: async () => {
                if (holding) {
                    holding = false;
                    await gate.promise;
                }
            },
        },
    };
}

async function sendFirstMessage(app: TestApp, text: string, beforeSend: () => void = () => {}): Promise<void> {
    const composer = await editableComposer(app);
    await app.user.click(composer);
    await app.user.paste(text);
    const send = await app.waitForView(() => {
        const button = getByRole(document.body, "button", { name: "Send message" });
        expect(button).toHaveProperty("disabled", false);
        return button;
    });
    // Configuration discovery also creates a Session, so hold only the message's own creation.
    beforeSend();
    await app.user.click(send);
}

test("Given Session creation failed for my first message and I wrote a next draft, When the page reloads, Then the first message returns to the composer ahead of the draft", {
    timeout: 60_000,
}, async () => {
    const creation = heldSessionCreation();
    const app = await createTestApp({ connectAgent: true, agent: creation.agent });
    await sendFirstMessage(app, "Original first message", creation.hold);
    await app.user.paste("Keep my new draft");
    creation.reject();
    await app.waitForView(() => getByRole(document.body, "button", { name: "Retry message" }));
    const reloaded = await app.reload();
    await reloaded.waitForView(() =>
        expect(reloaded.elementByTestId(dataTestId.messageComposer)).toHaveProperty(
            "value",
            "Original first message\n\nKeep my new draft",
        ),
    );
});

test("Given Session creation failed for my first message, When I start a new conversation, write an unrelated draft, and reload, Then only that draft returns", {
    timeout: 60_000,
}, async () => {
    const creation = heldSessionCreation();
    const app = await createTestApp({ connectAgent: true, agent: creation.agent });
    await sendFirstMessage(app, "Abandoned first message", creation.hold);
    creation.reject();
    await app.waitForView(() => getByRole(document.body, "button", { name: "Retry message" }));
    await app.user.click(app.elementByTestId(dataTestId.newConversation));
    const composer = await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) =>
            element instanceof HTMLTextAreaElement &&
            !element.disabled &&
            queryByRole(document.body, "button", { name: "Retry message" }) === null,
    );
    await app.user.click(composer);
    await app.user.paste("Unrelated draft");
    const reloaded = await app.reload();
    await reloaded.waitForView(() =>
        expect(reloaded.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "Unrelated draft"),
    );
});

test("Given my first message is waiting for Session creation, When the page reloads, Then the message returns to the composer", {
    timeout: 60_000,
}, async () => {
    const creation = heldSessionCreation();
    const app = await createTestApp({ connectAgent: true, agent: creation.agent });
    await sendFirstMessage(app, "Slow first message", creation.hold);
    await app.waitForView(() =>
        expect(app.optionalElementByTestId(dataTestId.initialMessageStatus)?.textContent).toBe("Sending message"),
    );
    const reloaded = await app.reload();
    await reloaded.waitForView(() =>
        expect(reloaded.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "Slow first message"),
    );
});

function conversationEntry(app: TestApp, title: string): HTMLElement | undefined {
    return app
        .elementsByTestId(dataTestId.managedConversation)
        .find((element) => element.textContent?.includes(title) === true);
}

async function openConversation(app: TestApp, title: string): Promise<HTMLTextAreaElement> {
    const entry = await app.waitForView(() => {
        const found = conversationEntry(app, title);
        if (found === undefined) {
            throw new Error(`Waiting for ${title} in the sidebar`);
        }
        return found;
    });
    await app.user.click(entry);
    await app.waitForView(() =>
        expect(
            app.elementsByTestId(dataTestId.userMessage).some((element) => element.textContent?.includes(title)),
        ).toBe(true),
    );
    return await editableComposer(app);
}

test("Given I left a new conversation while it was being created, When I attach a file there later and switch conversations, Then the file stays with that conversation", {
    timeout: 60_000,
}, async () => {
    const creation = heldSessionCreation();
    const app = await createTestApp({ connectAgent: true, agent: creation.agent });
    await sendFirstMessage(app, "Earlier conversation");
    await app.waitForView(() => expect(answered(app, "Earlier conversation")).toBe(true));
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await sendFirstMessage(app, "Created while away", creation.hold);
    await app.waitForView(() =>
        expect(app.optionalElementByTestId(dataTestId.initialMessageStatus)?.textContent).toBe("Sending message"),
    );
    await openConversation(app, "Earlier conversation");
    creation.release();
    const created = await openConversation(app, "Created while away");
    if (created.form === null) {
        throw new Error("Expected the message composer form");
    }
    await app.user.upload(
        getByLabelText(created.form, "Choose attachments"),
        new File(["Kept with its conversation"], "kept.json", { type: "text/plain" }),
    );
    await app.waitForView(() => getByRole(document.body, "button", { name: "Remove kept.json" }));
    await openConversation(app, "Earlier conversation");
    expect(queryByRole(document.body, "button", { name: "Remove kept.json" })).toBeNull();
    await openConversation(app, "Created while away");
    await app.waitForView(() => getByRole(document.body, "button", { name: "Remove kept.json" }));
});
