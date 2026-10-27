import { getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

for (const message of ["first", "subsequent"] as const) {
    test(`Given an unconfirmed ${message} message with an attachment, When Chat remounts and I retry, Then the original submission is delivered once`, {
        timeout: 60_000,
    }, async () => {
        const environment = await createChatWorkerEnvironment(true);
        onTestFinished(() => environment.close());
        const app = await createTestApp({ environment, connectAgent: true });
        const network = app.network;
        if (network === null) {
            throw new Error("Expected the response-loss network");
        }
        if (message === "subsequent") {
            await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Established session");
            await app.waitForView(() => {
                expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
                    "Established session",
                );
                expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
            });
        }
        const composer = await app.queryElementByTestId(dataTestId.messageComposer);
        await app.user.upload(
            getByLabelText(document.body, "Choose attachments"),
            new File(["Keep this attachment"], "pending.json", { type: "text/plain" }),
        );
        await app.waitForView(() =>
            expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain("pending.json"),
        );
        network.interruptNextTurn("before-acceptance");
        await sendPrompt(app, composer, "Retain this uncertain submission");
        await app.waitForView(() =>
            getByRole(document.body, "button", { name: "Retry message with unknown delivery" }),
        );
        const original = network.submissions.at(-1);
        const submissions = network.submissions.length;
        network.reconnect();
        await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: "Retry now" })));
        await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionReconnectNotice)).toBeNull());

        app.remount();
        const retry = await app.waitForView(() => {
            const button = getByRole(document.body, "button", { name: "Retry message with unknown delivery" });
            expect(button.hasAttribute("disabled")).toBe(false);
            return button;
        });
        expect(document.body.textContent).toContain("Retain this uncertain submission");
        expect(document.body.textContent).toContain("pending.json");
        expect(network.submissions).toHaveLength(submissions);
        await app.user.click(retry);
        await app.waitForView(() => {
            expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
                "Retain this uncertain submission",
            );
            expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        });
        expect(network.submissions).toHaveLength(submissions + 1);
        expect(network.submissions.at(-1)).toBe(original);
        expect(queryByRole(document.body, "button", { name: "Retry message with unknown delivery" })).toBeNull();
    });
}
