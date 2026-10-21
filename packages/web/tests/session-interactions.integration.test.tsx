import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

async function requestInput() {
    const app = await createTestApp({
        connectAgent: true,
        agent: { id: "interaction-test", label: "Interaction Agent" },
    });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the composer");
    }
    await sendPrompt(app, composer, "request user input");
    await app.waitForView(() => getByRole(document.body, "alertdialog", { name: "Agent permission request" }));
    return app;
}

test("Given a pending permission, When Chat remounts and the user allows it and answers the form, Then the agent receives the answer and both cards disappear", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput();
    app.remount();
    const permission = await app.waitForView(() =>
        getByRole(document.body, "alertdialog", { name: "Agent permission request" }),
    );
    await app.user.click(getByRole(permission, "button", { name: "Allow once" }));
    const form = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Agent information request" }));
    await app.user.type(getByRole(form, "textbox", { name: "Branch" }), "feature/separation");
    await app.user.click(getByRole(form, "button", { name: "Continue" }));
    await app.waitForView(() => expect(document.body.textContent).toContain("Selected branch: feature/separation"));
    expect(queryByRole(document.body, "alertdialog", { name: "Agent permission request" })).toBeNull();
    expect(queryByRole(document.body, "dialog", { name: "Agent information request" })).toBeNull();
});

test("Given a pending permission, When the user rejects it, Then the agent receives the rejection without showing an input form", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput();
    await app.user.click(getByRole(document.body, "button", { name: "Reject" }));
    await app.waitForView(() => expect(document.body.textContent).toContain("Permission rejected"));
    expect(queryByRole(document.body, "dialog", { name: "Agent information request" })).toBeNull();
});

test("Given an information request, When the user declines it, Then the agent receives the decline and the form disappears", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput();
    await app.user.click(getByRole(document.body, "button", { name: "Allow once" }));
    const form = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Agent information request" }));
    await app.user.click(getByRole(form, "button", { name: "Decline" }));
    await app.waitForView(() => expect(document.body.textContent).toContain("Input decline"));
    expect(queryByRole(document.body, "dialog", { name: "Agent information request" })).toBeNull();
});
