import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

test("Given legacy drafts beside a versioned request journal, When the browser reloads, Then drafts survive and a completed request is never sent again", {
    timeout: 60_000,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    onTestFinished(() => environment.close());
    const app = await createTestApp({ environment, connectAgent: true });
    const network = app.network;
    if (network === null) {
        throw new Error("Expected the real submission transport");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Completed before reload");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Completed before reload");
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
    });
    const sessionId = new URL(window.location.href).searchParams.get("sessionId");
    if (sessionId === null) {
        throw new Error("Expected the selected Session URL");
    }
    const { idempotencyKey, ...request } = JSON.parse(network.submissions.at(-1) ?? "{}");
    // Independently retained storage contracts: released Web stored drafts as raw strings and ignored other keys.
    // The additive journal is a frozen request, so neither reader may reinterpret it as a fresh draft.
    window.sessionStorage.setItem(`morty:message-draft:session:v1:${encodeURIComponent(sessionId)}`, "Legacy draft");
    window.sessionStorage.setItem(
        `morty:unsent-message:session:v1:${encodeURIComponent(sessionId)}`,
        "Legacy unsent message",
    );
    window.sessionStorage.setItem(
        `morty:pending-submission:v1:${encodeURIComponent(app.botId)}:${encodeURIComponent(sessionId)}`,
        JSON.stringify({ commandId: idempotencyKey, request }),
    );
    const submissions = network.submissions.length;
    const restored = await app.reload();
    const composer = await restored.waitForView(() => {
        expect(
            getByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" }),
        ).toBeTruthy();
        expect(queryByRole(document.body, "button", { name: "Retry message with unknown delivery" })).toBeNull();
        const element = restored.elementByTestId(dataTestId.messageComposer);
        expect(element).toHaveProperty("value", "Legacy unsent message\n\nLegacy draft");
        return element;
    });
    expect(network.submissions).toHaveLength(submissions);
    await restored.user.click(getByRole(document.body, "button", { name: "Send message" }));
    await restored.waitForView(() => {
        expect(restored.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain("Legacy draft");
        expect(composer).toHaveProperty("value", "");
    });
    expect(network.submissions).toHaveLength(submissions + 1);
});
