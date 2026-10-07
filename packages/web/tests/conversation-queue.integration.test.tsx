import { getByLabelText } from "@testing-library/dom";
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
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, "wait for steering");
    await app.queryElementByTestId(dataTestId.sessionStatus);
    const viewer = await app.openViewer();
    await viewer.queryElementByTestId(dataTestId.sessionStatus);
    await sendPrompt(
        app,
        (await app.queryElementByTestId(dataTestId.messageComposer)) as HTMLTextAreaElement,
        instruction,
    );
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
        expect(
            current
                .elementsByTestId(dataTestId.agentReplyStatus)
                .some((element) => element.textContent?.includes("steered") === true),
        ).toBe(false);
    }
    await sendPrompt(
        app,
        (await app.queryElementByTestId(dataTestId.messageComposer)) as HTMLTextAreaElement,
        deletedInstruction,
    );
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
        throw new Error("Expected a connected fake daemon");
    }
    daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await viewer.close();
});
