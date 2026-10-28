import { getByRole, queryAllByRole, queryAllByText, queryByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

const recoveredFailure = "The local Agent could not complete the request";

function sessionEntry(app: TestApp, title: string): HTMLElement {
    const entry = app
        .elementsByTestId(dataTestId.managedConversation)
        .find((element) => element.textContent?.includes(title));
    if (entry === undefined) {
        throw new Error(`Expected the ${title} Session in the sidebar`);
    }
    return entry;
}

function entryStatus(app: TestApp, title: string): string | null {
    return (
        sessionEntry(app, title)
            .querySelector(`[data-testid="${dataTestId.sessionStatus}"]`)
            ?.getAttribute("aria-label") ?? null
    );
}

test("Given a turn that fails while I am in another Session, When I return, Then I see its failure, the sidebar agrees, and my next message clears it", {
    timeout: 60_000,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const network = app.network;
    if (network === null) {
        throw new Error("Expected the controllable network");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Established session");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    network.holdNextTurn();
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "fail this turn explicitly");
    await app.waitForView(() => expect(network.submissions.at(-1)).toContain("fail this turn explicitly"));

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    network.releaseHeldTurn();
    // The turn ran and ended while another Session was selected.
    await app.waitForView(() => expect(entryStatus(app, "Established session")).toBe("Unread response"));

    await app.user.click(sessionEntry(app, "Established session"));
    const composer = await app.waitForView(() => {
        expect(queryAllByText(document.body, recoveredFailure, { exact: true })).toHaveLength(1);
        expect(entryStatus(app, "Established session")).toBe("Session failed");
        expect(queryByRole(document.body, "button", { name: "Retry message with unknown delivery" })).toBeNull();
        const element = app.elementByTestId(dataTestId.messageComposer);
        if (!(element instanceof HTMLTextAreaElement) || element.disabled) {
            throw new Error("Expected an enabled message composer");
        }
        return element;
    });
    expect(
        app
            .elementsByTestId(dataTestId.userMessage)
            .filter((element) => element.textContent?.includes("fail this turn explicitly")),
    ).toHaveLength(1);

    await sendPrompt(app, composer, "Keep chatting");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Keep chatting");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        expect(queryAllByText(document.body, recoveredFailure, { exact: true })).toHaveLength(0);
        expect(entryStatus(app, "Established session")).toBeNull();
    });
});

test("Given my last turn completed while I was away after an earlier failure, When I return, Then no stale failure is shown", {
    timeout: 60_000,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const network = app.network;
    if (network === null) {
        throw new Error("Expected the controllable network");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull());
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "fail this turn explicitly");
    await app.waitForView(() => expect(entryStatus(app, "Established session")).toBe("Session failed"));
    network.holdNextTurn();
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Finish while away");
    await app.waitForView(() => expect(network.submissions.at(-1)).toContain("Finish while away"));

    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    network.releaseHeldTurn();
    await app.waitForView(() => expect(entryStatus(app, "Established session")).toBe("Unread response"));

    await app.user.click(sessionEntry(app, "Established session"));
    await app.waitForView(() => {
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain("Finish while away");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        expect(entryStatus(app, "Established session")).toBeNull();
        expect(queryAllByText(document.body, recoveredFailure, { exact: true })).toHaveLength(0);
        expect(queryAllByRole(document.body, "alert")).toHaveLength(0);
    });
});
