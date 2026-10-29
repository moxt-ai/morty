import { resolveObjectURL } from "node:buffer";
import { fireEvent, getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given the daemon has queued work, When the user steers it into the active turn, Then every viewer sees the steered reply", {
    timeout: 30_000,
}, async () => {
    const instruction = "Use the revised requirement";
    const deletedInstruction = "Add a footer that should be deleted";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    const viewer = await app.openViewer();
    await viewer.queryElementByTestId(dataTestId.sessionStatus);
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), instruction);
    const queued = await viewer.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(instruction) === true,
    );
    for (const current of [app, viewer]) {
        expect(
            current
                .elementsByTestId(dataTestId.userMessage)
                .some((element) => element.textContent?.includes(instruction) === true),
        ).toBe(false);
    }
    await viewer.user.click(getByLabelText(queued, `Steer queued message: ${instruction}`));
    for (const current of [app, viewer]) {
        await current.waitForView(() =>
            expect(
                current
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes("Waiting for steering") === true),
            ).toBe(true),
        );
        await current.waitForView(() =>
            expect(
                current
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes(`Steered: ${instruction}`) === true),
            ).toBe(true),
        );
        await current.waitForView(() => expect(current.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull());
        await current.queryElementByTestId(dataTestId.sessionStatus);
        await current.waitForView(() =>
            expect(current.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
                "wait for steering",
                instruction,
            ]),
        );
        expect(
            current
                .elementsByTestId(dataTestId.agentReplyStatus)
                .some((element) => element.textContent?.includes("steered") === true),
        ).toBe(false);
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), deletedInstruction);
    const queuedForDeletion = await viewer.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(deletedInstruction) === true,
    );
    await viewer.user.click(getByLabelText(queuedForDeletion, `Delete queued message: ${deletedInstruction}`));
    for (const current of [app, viewer]) {
        await current.waitForView(() => expect(current.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull());
        await current.queryElementByTestId(dataTestId.sessionStatus);
        await current.waitForView(() => {
            expect(
                current
                    .elementsByTestId(dataTestId.userMessage)
                    .some((element) => element.textContent?.includes(deletedInstruction) === true),
            ).toBe(false);
            expect(
                current
                    .elementsByTestId(dataTestId.agentReplyStatus)
                    .some((element) => element.textContent?.includes("cancelled") === true),
            ).toBe(false);
        });
    }
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await viewer.close();
});

test("Given a follow-up is queued, When the user stops the active turn, Then the started follow-up appears in the message list", {
    timeout: 30_000,
}, async () => {
    const activePrompt = "wait for steering";
    const queuedPrompt = "Explain Golang ==";
    const app = await createTestApp({ connectAgent: true, agent: { id: "pi", label: "Pi" } });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, activePrompt);
    await app.queryElementByTestId(
        dataTestId.sendMessage,
        (element) => element.getAttribute("aria-label") === "Stop agent output",
    );
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), queuedPrompt);
    await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(queuedPrompt) === true,
    );

    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.sendMessage,
            (element) => element.getAttribute("aria-label") === "Stop agent output",
        ),
    );

    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            activePrompt,
            queuedPrompt,
        ]),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
});

test("Given a follow-up is queued and the user has started another draft, When they edit the queued follow-up, Then it leaves the queue and returns to the composer ahead of the draft", {
    timeout: 30_000,
}, async () => {
    const queuedPrompt = "Use the revised requirement";
    const draft = "Also keep the footer";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), queuedPrompt);
    const queued = await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(queuedPrompt) === true,
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.messageComposer));
    await app.user.paste(draft);

    await app.user.click(getByLabelText(queued, `Edit queued message: ${queuedPrompt}`));

    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull());
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", `${queuedPrompt}\n\n${draft}`),
    );
    expect(document.body.textContent).not.toContain("Files attached to the queued message");
});

test("Given a reply is running with a queued follow-up, When I edit the follow-up, Then all viewers keep the reply running and only the revised message executes", {
    timeout: 30_000,
}, async () => {
    const queuedPrompt = "OLD_QUEUED_INSTRUCTION";
    const revisedPrompt = "REVISED_QUEUED_INSTRUCTION";
    const app = await createTestApp({ connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    const viewer = await app.openViewer();
    await viewer.queryElementByTestId(dataTestId.sessionStatus);
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), queuedPrompt);
    const queued = await app.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(queuedPrompt) === true,
    );

    await app.user.click(getByLabelText(queued, `Edit queued message: ${queuedPrompt}`));

    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", queuedPrompt),
    );
    for (const current of [app, viewer]) {
        await current.waitForView(() => expect(current.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull());
        expect(current.optionalElementByTestId(dataTestId.sessionStatus)).not.toBeNull();
        expect(
            current.elementsByTestId(dataTestId.agentReplyStatus).map((element) => element.textContent),
        ).not.toContain("Turn stopped.");
    }
    if (app.daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await app.daemon.continueReply("wait for steering", {
        outcome: "complete",
        output: [{ kind: "text", text: "Original reply completed" }],
    });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.clear(app.elementByTestId(dataTestId.messageComposer));
    await sendPrompt(app, app.elementByTestId(dataTestId.messageComposer), revisedPrompt);
    for (const current of [app, viewer]) {
        await current.waitForView(() =>
            expect(
                current
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((item) => item.textContent?.includes(revisedPrompt)),
            ).toBe(true),
        );
        expect(current.elementsByTestId(dataTestId.userMessage).map((element) => element.textContent)).toEqual([
            "wait for steering",
            revisedPrompt,
        ]);
        expect(
            current.elementsByTestId(dataTestId.agentResponse).some((item) => item.textContent?.includes(queuedPrompt)),
        ).toBe(false);
    }
    await viewer.close();
});

test("Given this browser queued an attachment and the queue refreshed, When I edit and resend it, Then the original file is restored and delivered", {
    timeout: 30_000,
}, async () => {
    const queuedPrompt = "Describe the queued image";
    const imageBytes = Uint8Array.from(
        atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4oKAAAAM0ATE4/UtcAAAAAElFTkSuQmCC"),
        (character) => character.charCodeAt(0),
    );
    const app = await createTestApp({ connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    await app.waitForView(() =>
        expect(getByLabelText(document.body, "Choose attachments")).toHaveProperty("disabled", false),
    );
    await app.user.upload(
        getByLabelText(document.body, "Choose attachments"),
        new File([imageBytes], "queued.png", { type: "image/png" }),
    );
    await app.waitForView(() =>
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("queued.png"),
    );
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), queuedPrompt);
    await app.queryElementByTestId(dataTestId.queuedMessage);
    await app.waitForView(() => {
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", "");
        expect(queryByRole(document.body, "list", { name: "Attachments" })).toBeNull();
    });

    // A second accepted message refreshes the authoritative queue, including the first message.
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Refresh the queue");
    await app.waitForView(() => expect(app.elementsByTestId(dataTestId.queuedMessage)).toHaveLength(2));
    await app.waitForView(() => expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", ""));
    await app.user.click(getByLabelText(document.body, `Edit queued message: ${queuedPrompt}`));
    await app.waitForView(() => {
        expect(app.elementByTestId(dataTestId.messageComposer)).toHaveProperty("value", queuedPrompt);
        expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("queued.png");
    });
    expect(document.body.textContent).not.toContain("Files attached to the queued message could not be restored here.");

    if (app.daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await app.daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(getByRole(document.body, "button", { name: "Send message" }));
    const source = await app.waitForView(() => {
        expect(
            app.elementsByTestId(dataTestId.agentResponse).some((item) => item.textContent?.includes(queuedPrompt)),
        ).toBe(true);
        const message = app
            .elementsByTestId(dataTestId.userMessage)
            .find((item) => item.textContent?.includes(queuedPrompt));
        expect(message).toBeDefined();
        const source = getByRole(message ?? document.body, "img", { name: "Your attachment" }).getAttribute("src");
        expect(source?.startsWith("blob:")).toBe(true);
        return source;
    });
    const image = source === null ? undefined : resolveObjectURL(source);
    if (image === undefined) {
        throw new Error("Expected the delivered attachment image");
    }
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(imageBytes);
});

test("Given a follow-up with a file was queued from another browser, When this viewer edits it, Then its text returns and Chat explains that the file must be added again", {
    timeout: 30_000,
}, async () => {
    const queuedPrompt = "Summarize the attached notes";
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    const viewer = await app.openViewer();
    await viewer.queryElementByTestId(dataTestId.sessionStatus);
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement) || composer.form === null) {
        throw new Error("Expected the message composer form");
    }
    const form = composer.form;
    await app.user.click(composer);
    await app.user.paste(queuedPrompt);
    act(() => {
        fireEvent.change(getByLabelText(form, "Choose attachments"), {
            target: { files: [new File(["Attachment contents"], "notes.txt", { type: "text/plain" })] },
        });
    });
    await app.waitForView(() =>
        expect(getByRole(form, "list", { name: "Attachments" }).textContent).toContain("notes.txt"),
    );
    await app.user.click(getByRole(form, "button", { name: "Send message" }));
    const queued = await viewer.queryElementByTestId(
        dataTestId.queuedMessage,
        (element) => element.textContent?.includes(queuedPrompt) === true,
    );

    await viewer.user.click(getByLabelText(queued, `Edit queued message: ${queuedPrompt}`));

    const viewerComposer = viewer.elementByTestId(dataTestId.messageComposer);
    if (!(viewerComposer instanceof HTMLTextAreaElement) || viewerComposer.form === null) {
        throw new Error("Expected the viewer's message composer form");
    }
    const viewerForm = viewerComposer.form;
    await viewer.waitForView(() => expect(viewerComposer).toHaveProperty("value", queuedPrompt));
    expect(viewerForm.querySelector('[aria-label="Attachments"]')).toBeNull();
    await viewer.waitForView(() =>
        expect(document.body.textContent).toContain("Files attached to the queued message could not be restored here."),
    );
});
