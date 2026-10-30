import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { openAgentModelPicker, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given a streaming response, When I change its session model, Then the change is acknowledged without interrupting output and I can still stop the response", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected the connected Runtime");
    }
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "wait for steering");
    await app.queryElementByTestId(
        dataTestId.agentResponse,
        (element) => element.textContent?.includes("Waiting for steering") === true,
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    expect(getByRole(configuration, "combobox", { name: "Model" }).hasAttribute("disabled")).toBe(false);
    expect(configuration.textContent).toContain("New settings may not affect this response.");
    await openAgentModelPicker(app);
    await app.user.click(await app.queryElementByTestId(dataTestId.sessionConfigValue("test-large")));
    await app.waitForView(() => {
        expect(getByRole(configuration, "combobox", { name: "Model" }).textContent).toContain("Test Large");
        expect(getByRole(configuration, "combobox", { name: "Model" }).getAttribute("aria-busy")).toBeNull();
    });
    await app.user.click(getByRole(configuration, "button", { name: "Close Agent configuration" }));
    await daemon.continueReply("wait for steering", {
        outcome: "hold",
        output: [{ kind: "text", text: "Still streaming after the settings change." }],
    });
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
            "Still streaming after the settings change.",
        );
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).not.toBeNull();
    });
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    await app.user.click(getByRole(document.body, "button", { name: "Stop current response" }));
    await app.waitForView(() => {
        expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
        expect(queryByRole(document.body, "button", { name: "Stop current response" })).toBeNull();
    });
    await app.user.click(getByRole(document.body, "button", { name: "Close Agent configuration" }));
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Continue with saved settings");
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
            "Continue with saved settings",
        );
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large");
    });
});

test("Given a response waiting for permission, When I change mode, effort, speed and model, Then the pending request remains explicit and the next turn uses the confirmed settings", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        agent: { id: "configuration-test", label: "Settings Agent" },
    });
    await sendPrompt(
        app,
        await app.queryElementByTestId(dataTestId.messageComposer),
        "Wait for permission with current settings",
    );
    await app.waitForView(() => getByRole(document.body, "alertdialog", { name: "Agent permission request" }));
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    for (const { label, value } of [
        { label: "Mode", value: "Plan" },
        { label: "Effort", value: "Low" },
    ]) {
        expect(getByRole(document.body, "combobox", { name: label }).hasAttribute("disabled")).toBe(false);
        await app.user.click(getByRole(document.body, "combobox", { name: label }));
        await app.user.click(getByRole(document.body, "option", { name: value }));
        await app.waitForView(() => {
            const control = getByRole(document.body, "combobox", { name: label });
            expect(control.textContent).toContain(value);
            expect(control.getAttribute("aria-busy")).toBeNull();
        });
    }
    await app.user.click(getByRole(document.body, "switch", { name: "Fast mode" }));
    await app.waitForView(() =>
        expect(getByRole(document.body, "switch", { name: "Fast mode" }).getAttribute("aria-checked")).toBe("true"),
    );
    await openAgentModelPicker(app);
    await app.user.click(await app.queryElementByTestId(dataTestId.sessionConfigValue("test-large")));
    await app.waitForView(() =>
        expect(getByRole(document.body, "combobox", { name: "Model" }).textContent).toContain("Test Large"),
    );
    await app.user.click(getByRole(document.body, "button", { name: "Close Agent configuration" }));
    const permission = getByRole(document.body, "alertdialog", { name: "Agent permission request" });
    await app.user.click(getByRole(permission, "button", { name: "Deny" }));
    await app.waitForView(() => {
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
            "Permission decision: deny",
        );
        expect(queryByRole(document.body, "alertdialog", { name: "Agent permission request" })).toBeNull();
    });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Report current settings");
    await app.waitForView(() =>
        expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
            "Current settings: mode=plan, model=test-large, effort=low, fast=true",
        ),
    );
});
