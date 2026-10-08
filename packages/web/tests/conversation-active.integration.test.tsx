import { queryAllByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

async function loadAllResponseText(app: Awaited<ReturnType<typeof createTestApp>>) {
    while (true) {
        const buttons = queryAllByRole(document.body, "button", { name: "Load more text" });
        const button = buttons[0];
        if (button === undefined) {
            return;
        }
        await app.user.click(button);
    }
}

test("Given interleaved live text and tool events, When the agent responds, Then Chat shows each item in arrival order", {
    timeout: 30_000,
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

    await sendPrompt(app, composer, "show live output in order");

    await app.waitForView(() => {
        const responses = app.elementsByTestId(dataTestId.agentResponse);
        expect(responses).toHaveLength(3);
        expect(responses[0]?.textContent).toContain("First live message");
        expect(responses[1]?.textContent).toContain("Later live tool");
        expect(responses[2]?.textContent).toContain("Final live message");
    });
});

test("Given an active turn exceeds one recovery page, When the user leaves and reopens the conversation, Then Chat restores every character and rich content", {
    timeout: 30_000,
}, async () => {
    const prompt = "hold after large output";
    const expectedCharacters = 300_000;
    const app = await createTestApp({ connectAgent: true });
    const responseCharacters = () =>
        app
            .elementsByTestId(dataTestId.agentResponse)
            .flatMap((element) => element.textContent?.match(/x{100,}/gu) ?? [])
            .reduce((total, text) => total + text.length, 0);
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the message composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await app.waitForView(() =>
        expect(queryAllByRole(document.body, "button", { name: "Load more text" })).not.toHaveLength(0),
    );
    await loadAllResponseText(app);
    await app.waitForView(() =>
        expect(responseCharacters(), document.body.textContent?.slice(0, 2000)).toBe(expectedCharacters),
    );
    await app.waitForView(() => expect(document.body.textContent).toContain("long-output.bin"));
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    const activeConversation = await app.waitForView(() => {
        const conversation = app
            .elementsByTestId(dataTestId.managedConversation)
            .find((candidate) => candidate.textContent?.includes(prompt) === true);
        if (conversation === undefined) {
            throw new Error(`The active conversation is unavailable: ${document.body.textContent}`);
        }
        return conversation;
    });
    await app.user.click(activeConversation);
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await app.waitForView(() =>
        expect(queryAllByRole(document.body, "button", { name: "Load more text" })).not.toHaveLength(0),
    );
    await loadAllResponseText(app);
    await app.waitForView(() =>
        expect(responseCharacters(), document.body.textContent?.slice(0, 2000)).toBe(expectedCharacters),
    );
    await app.waitForView(() => expect(document.body.textContent).toContain("long-output.bin"));
    const stop = await app.queryElementByTestId(
        dataTestId.sendMessage,
        (element) => element.getAttribute("aria-label") === "Stop agent output",
    );
    await app.user.click(stop);
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    expect(document.body.textContent).toContain(prompt);
});

test("Given a partially streamed reply, When Chat remounts and the daemon continues, Then the restored prefix and file survive subsequent deltas", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected composer");
    }
    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Partial reply") === true),
        ).toBe(true),
    );
    app.remount();
    await app.queryElementByTestId(dataTestId.sessionStatus);
    await app.waitForView(() => expect(document.body.textContent).toContain("partial.bin"));
    await daemon.continueReply("hold after first delta", {
        outcome: "hold",
        output: [{ kind: "text", text: " and the next streamed chunk" }],
    });
    await app.waitForView(() => {
        const text = app
            .elementsByTestId(dataTestId.agentResponse)
            .map((element) => element.textContent)
            .join("");
        expect(text).toContain("Partial reply");
        expect(text).toContain("and the next streamed chunk");
        expect(document.body.textContent).toContain("partial.bin");
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).not.toBeNull();
    });
    await daemon.continueReply("hold after first delta", {
        outcome: "complete",
        output: [{ kind: "text", text: " and the final chunk" }],
    });
    const text = await app.waitForView(() => {
        expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull();
        const response = app
            .elementsByTestId(dataTestId.agentResponse)
            .map((element) => element.textContent)
            .join("");
        expect(response).toContain("and the final chunk");
        return response;
    });
    expect(text.match(/Partial reply/gu)).toHaveLength(1);
    expect(text.match(/and the next streamed chunk/gu)).toHaveLength(1);
    expect(text.match(/and the final chunk/gu)).toHaveLength(1);
    expect(document.body.textContent).toContain("partial.bin");
});

test("Given a conversation is running in the background, When it completes after starting a new conversation, Then its spinner becomes an unread badge", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected composer");
    }
    await sendPrompt(app, composer, "hold after first delta");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Partial reply") === true),
        ).toBe(true),
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.queryElementByTestId(dataTestId.sessionStatus);
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await daemon.continueReply("hold after first delta", { outcome: "complete", output: [] });
    await app.queryElementByTestId(
        dataTestId.sessionStatus,
        (element) => element.getAttribute("aria-label") === "Unread response",
    );
    const completedConversation = app
        .elementsByTestId(dataTestId.managedConversation)
        .find((element) => element.textContent?.includes("hold after first delta") === true);
    if (completedConversation === undefined) {
        throw new Error("Expected the completed conversation");
    }
    await app.user.click(completedConversation);
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.sessionStatus)
                .some((element) => element.getAttribute("aria-label") === "Unread response"),
        ).toBe(false),
    );
});
