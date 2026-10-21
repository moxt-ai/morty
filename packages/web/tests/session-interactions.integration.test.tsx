import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

async function requestInput(prompt = "request user input") {
    const app = await createTestApp({
        connectAgent: true,
        agent: { id: "interaction-test", label: "Interaction Agent" },
    });
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the composer");
    }
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() => getByRole(document.body, "alertdialog", { name: "Agent permission request" }));
    return app;
}

test("Given a pending permission, When Chat remounts and the user allows it and answers the form, Then the agent receives the answer and both cards disappear", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput();
    const initial = getByRole(document.body, "alertdialog", { name: "Agent permission request" });
    expect(initial.textContent).toContain("pnpm test -- --reporter=verbose");
    expect(initial.textContent).toContain("src/<entry>.ts");
    expect(getByRole(initial, "region", { name: "Session working directory" }).textContent).not.toBe("");
    app.remount();
    const permission = await app.waitForView(() =>
        getByRole(document.body, "alertdialog", { name: "Agent permission request" }),
    );
    expect(permission.textContent).toContain("pnpm test -- --reporter=verbose");
    expect(permission.textContent).toContain("src/<entry>.ts");
    await app.user.click(getByRole(permission, "button", { name: "Allow this action" }));
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
    await app.user.click(getByRole(document.body, "button", { name: "Deny this action" }));
    await app.waitForView(() => expect(document.body.textContent).toContain("Permission rejected"));
    expect(queryByRole(document.body, "dialog", { name: "Agent information request" })).toBeNull();
});

test("Given an information request, When the user declines it, Then the agent receives the decline and the form disappears", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput();
    await app.user.click(getByRole(document.body, "button", { name: "Allow this action" }));
    const form = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Agent information request" }));
    await app.user.click(getByRole(form, "button", { name: "Decline" }));
    await app.waitForView(() => expect(document.body.textContent).toContain("Input decline"));
    expect(queryByRole(document.body, "dialog", { name: "Agent information request" })).toBeNull();
});

test("Given a pending permission, When the user stops the turn, Then the turn ends without approving the action or requesting more input", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput();
    const permission = getByRole(document.body, "alertdialog", { name: "Agent permission request" });
    await app.user.click(getByRole(permission, "button", { name: "Stop turn" }));
    await app.waitForView(() =>
        expect(queryByRole(document.body, "alertdialog", { name: "Agent permission request" })).toBeNull(),
    );
    await app.waitForView(() => expect(getByRole(document.body, "button", { name: "Send message" })).toBeDefined());
    expect(queryByRole(document.body, "dialog", { name: "Agent information request" })).toBeNull();
});

test("Given an agent omits the original input, When permission is requested, Then the missing details are explicit and the action can still be denied", {
    timeout: 30_000,
}, async () => {
    const app = await requestInput("request without tool input");
    const permission = getByRole(document.body, "alertdialog", { name: "Agent permission request" });
    expect(permission.textContent).toContain("The agent did not provide the original tool input.");
    await app.user.click(getByRole(permission, "button", { name: "Deny this action" }));
    await app.waitForView(() => expect(document.body.textContent).toContain("Permission rejected"));
});
