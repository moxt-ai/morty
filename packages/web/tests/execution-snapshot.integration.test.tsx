import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

test("Given a completed execution snapshot, When a buffered start event precedes its delayed completion, Then the viewer keeps the completed turn idle", {
    timeout: dedicatedEnvironmentTimeout,
}, async () => {
    const environment = await createChatWorkerEnvironment(false, true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true, clock: new TestClock("2030-01-01T00:00:00Z") });
    const { daemon, executionNetwork } = app;
    if (daemon === null || executionNetwork === null) {
        throw new Error("Expected the real Runtime and proxy");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Execution snapshot baseline");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).length).toBeGreaterThan(0);
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
    });

    const execution = executionNetwork.holdNextExecution();
    const viewer = await app.openViewer();
    const releaseExecution = await execution;
    const terminal = executionNetwork.holdTerminalSessionEvents();
    let executionReleased = false;
    try {
        await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "hold after first delta");
        await app.queryElementByTestId(dataTestId.sessionStatus);
        await app.waitForView(() =>
            expect(
                app
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((item) => item.textContent?.includes("Partial reply")),
            ).toBe(true),
        );
        await daemon.continueReply("hold after first delta", {
            outcome: "complete",
            output: [{ kind: "text", text: "Execution snapshot finished" }],
        });
        await terminal.observed;
        // The real Runtime has recorded completion before this held request is sent to it.
        releaseExecution();
        executionReleased = true;
        await viewer.queryElementByTestId(
            dataTestId.messageComposer,
            (element) => element instanceof HTMLTextAreaElement && !element.disabled,
        );
        // Seeing this later real output establishes that the buffered start has also been processed.
        await viewer.waitForView(() =>
            expect(
                viewer
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((item) => item.textContent?.includes("Partial reply")),
            ).toBe(true),
        );
        const snapshot = executionNetwork.observedExecutionReads().at(-1);
        expect(snapshot).toMatchObject({ turn: null, lastTurnState: "completed" });
        await viewer.waitForView(() => {
            expect(viewer.elementByTestId(dataTestId.sendMessage).getAttribute("aria-label")).toBe("Send message");
            expect(viewer.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
        });
    } finally {
        if (!executionReleased) {
            releaseExecution();
        }
        terminal.release();
        await viewer.waitForView(() => expect(viewer.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
        await viewer.close();
        await app.close();
    }
});
