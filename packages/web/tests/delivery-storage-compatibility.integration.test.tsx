import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { createChatWorkerEnvironment, dedicatedEnvironmentTimeout } from "./support/chat-worker.ts";

test("Given a Computer-scoped draft beside retired scalar drafts and a completed request journal, When the browser reloads, Then only the current draft survives and the completed request is never sent again", {
    timeout: dedicatedEnvironmentTimeout,
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
    await app.user.type(app.elementByTestId(dataTestId.messageComposer), "Current Computer draft");
    // The authorized pre-launch reset retires scalar keys. Keep them as an independent old-storage fixture:
    // they must neither replace this Computer's current draft nor replay an earlier completed request.
    window.sessionStorage.setItem(`morty:message-draft:session:v1:${encodeURIComponent(sessionId)}`, "Legacy draft");
    window.sessionStorage.setItem(
        `morty:unsent-message:session:v1:${encodeURIComponent(sessionId)}`,
        "Legacy unsent message",
    );
    window.sessionStorage.setItem(
        `morty:pending-submission:v1:${encodeURIComponent(app.computerId)}:${encodeURIComponent(sessionId)}`,
        JSON.stringify({ commandId: idempotencyKey, placement: "turn", request }),
    );
    const submissions = network.submissions.length;
    const restored = await app.reload();
    const composer = await restored.waitForView(() => {
        expect(
            getByRole(document.body, "button", { name: /Switch computer/, description: "Connection available" }),
        ).toBeTruthy();
        expect(queryByRole(document.body, "button", { name: "Retry message with unknown delivery" })).toBeNull();
        const element = restored.elementByTestId(dataTestId.messageComposer);
        expect(element).toHaveProperty("value", "Current Computer draft");
        return element;
    });
    expect(network.submissions).toHaveLength(submissions);
    await restored.user.click(getByRole(document.body, "button", { name: "Send message" }));
    await restored.waitForView(() => {
        expect(restored.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
            "Current Computer draft",
        );
        expect(composer).toHaveProperty("value", "");
    });
    expect(network.submissions).toHaveLength(submissions + 1);
});
