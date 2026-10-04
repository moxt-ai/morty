import { getByLabelText } from "@testing-library/dom";
import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given the daemon has queued work, When the user steers it into the active turn, Then every viewer sees the steered reply", {
    timeout: 30_000,
}, async () => {
    const instruction = "Use the revised requirement";
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
    await viewer.user.click(getByLabelText(queued, `Steer queued message: ${instruction}`));
    for (const current of [app, viewer]) {
        await vi.waitFor(() =>
            expect(
                current
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes(`Steered: ${instruction}`) === true),
            ).toBe(true),
        );
        await vi.waitFor(() => expect(current.optionalElementByTestId(dataTestId.queuedMessage)).toBeNull());
    }
    await viewer.close();
});
