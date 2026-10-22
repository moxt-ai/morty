import { getByRole, getByText, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

async function readDirectory(app: TestApp): Promise<string> {
    await app.user.click(getByRole(document.body, "button", { name: "Show execution details" }));
    const dialog = getByRole(document.body, "dialog", { name: "Execution details" });
    const directory = app.elementByTestId(dataTestId.executionDirectory, dialog).textContent ?? "";
    expect(directory.length).toBeGreaterThan(0);
    await app.user.keyboard("{Escape}");
    expect(queryByRole(document.body, "dialog", { name: "Execution details" })).toBeNull();
    return directory;
}

test("Given a connected Runtime, When a draft becomes a saved session and reconnects, Then its execution context stays visible and reflects the session connection", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, clock: new TestClock("2026-10-21T08:00:00Z") });
    await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
    const context = () => getByRole(document.body, "region", { name: "Execution context" });
    await app.waitForView(() => {
        expect(context().textContent).toContain("Codex");
        expect(context().textContent).toContain("Connected");
    });
    expect(getByText(context(), "workspace", { exact: true })).toBeDefined();
    const summary = getByRole(context(), "button", { name: "Show execution details" });
    expect(summary.textContent).not.toContain("Controlled Agent Runtime");
    expect(summary.textContent).not.toContain("Connected");
    expect(getByRole(document.body, "button", { name: /Switch computer/ }).textContent).toContain("Online");
    const directoryName = await readDirectory(app);
    await sendPrompt(app, app.elementByTestId(dataTestId.messageComposer), "Remember this execution context");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Codex turn 1")),
        ).toBe(true),
    );
    expect(await readDirectory(app)).toBe(directoryName);
    if (app.daemon === null) {
        throw new Error("Expected a connected Runtime");
    }
    await app.daemon.disconnect();
    await app.waitForView(() => expect(context().textContent).toContain("Disconnected"));
    expect(getByRole(context(), "button", { name: "Show execution details" }).textContent).toContain(
        "Session: Disconnected",
    );
    expect(await readDirectory(app)).toBe(directoryName);
    await app.daemon.reconnect();
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: "Retry now" })));
    await app.waitForView(() => expect(context().textContent).toContain("Connected"));
});

test("Given a saved conversation and a different draft directory, When the user switches conversations, Then the context follows the selected conversation rather than the draft default", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const context = () => getByRole(document.body, "region", { name: "Execution context" });
    await app.waitForView(() => expect(context().textContent).toContain("Codex"));
    const originalDirectory = await readDirectory(app);
    expect(getByRole(document.body, "button", { name: /Switch computer/ }).textContent).toContain(
        "Controlled Agent Runtime",
    );
    await sendPrompt(
        app,
        await app.queryElementByTestId(dataTestId.messageComposer),
        "Original directory conversation",
    );
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Original directory conversation")),
        ).toBe(true),
    );
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
    await app.user.click(app.elementByTestId(dataTestId.newConversation));
    await app.user.click(await app.queryElementByTestId(dataTestId.workingDirectory));
    await app.user.click(app.elementByTestId(dataTestId.changeWorkingDirectory));
    await app.user.click(await app.waitForView(() => getByRole(document.body, "button", { name: ".." })));
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.saveWorkingDirectory,
            (element) => element instanceof HTMLButtonElement && !element.disabled,
        ),
    );
    await app.waitForView(() =>
        expect(queryByRole(document.body, "dialog", { name: "Choose working directory" })).toBeNull(),
    );
    const changedDirectory = await readDirectory(app);
    expect(changedDirectory).not.toBe(originalDirectory);
    await sendPrompt(app, app.elementByTestId(dataTestId.messageComposer), "Changed directory conversation");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Changed directory conversation")),
        ).toBe(true),
    );
    for (const { title, expectedDirectory } of [
        { title: "Original directory conversation", expectedDirectory: originalDirectory },
        { title: "Changed directory conversation", expectedDirectory: changedDirectory },
    ]) {
        const saved = await app.waitForView(() => {
            const conversation = app
                .elementsByTestId(dataTestId.managedConversation)
                .find((element) => element.textContent?.includes(title));
            if (conversation === undefined) {
                throw new Error(
                    `Waiting for ${title}: ${app
                        .elementsByTestId(dataTestId.managedConversation)
                        .map((element) => element.textContent)
                        .join(" | ")}`,
                );
            }
            return conversation;
        });
        await app.user.click(saved);
        await app.waitForView(() => {
            expect(getByRole(context(), "status", { name: "Connection" }).textContent).toBe("Connected");
        });
        expect(await readDirectory(app)).toBe(expectedDirectory);
    }
});

test("Given no paired Runtime, When the user dismisses setup, Then the context reports unknown execution details and a disconnected connection", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    await app.queryElementByTestId(dataTestId.pairingInstruction);
    await app.user.click(getByRole(document.body, "button", { name: "Close dialog" }));
    const context = getByRole(document.body, "region", { name: "Execution context" });
    await app.user.click(getByRole(context, "button", { name: "Show execution details" }));
    expect(getByRole(document.body, "dialog", { name: "Execution details" }).textContent).toContain("MachineUnknown");
    await app.user.keyboard("{Escape}");
    expect(context.textContent).toContain("Agent Unknown");
    expect(context.textContent).toContain("Working directory: Unknown");
    expect(getByRole(context, "status", { name: "Connection" }).textContent).toBe("Disconnected");
});
