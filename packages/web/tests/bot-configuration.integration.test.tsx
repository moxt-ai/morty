import { getAllByRole, getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { openAgentModelPicker, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

async function waitForConnection(app: TestApp, status: string): Promise<void> {
    await app.waitForView(() => {
        const statuses = app.elementsByTestId(dataTestId.botConnectionStatus);
        expect(statuses.length).toBeGreaterThan(0);
        expect(statuses.every((element) => element.getAttribute("data-connection-status") === status)).toBe(true);
    });
}

test("Given Morty has no paired agent, When the setup page opens, Then it offers the current-origin setup instruction without a data region selector", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    const pairing = await app.queryElementByTestId(dataTestId.pairingInstruction);

    expect(pairing).toBeInstanceOf(HTMLTextAreaElement);
    expect(pairing).toHaveProperty("readOnly", true);
    expect(pairing).toHaveProperty("value", expect.stringContaining(`${window.location.origin}/setup.md`));
    expect(queryByRole(document.body, "combobox", { name: "Data region" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Refresh pairing instruction" })).toBeNull();
    const dialog = getByRole(document.body, "dialog", { name: "Connect agent" });
    expect(getByRole(dialog, "button", { name: "Copy setup prompt" })).toBeInstanceOf(HTMLButtonElement);
    expect(dialog.textContent).not.toContain("Connect your agent to Morty");
    expect(dialog.textContent).not.toContain("Works with Codex, Claude Code, and Pi.");
    expect(dialog.textContent).not.toContain("Local execution. Remote access you can revoke.");
});

test("Given a paired Bot, When its Runtime disconnects, Then the disconnected status is visible", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        prepare: async (application) => {
            const runtime = await application.connectAgent();
            await runtime.disconnect();
        },
    });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "disconnected",
    );
});

test("Given a paired Bot with cached agent settings, When a user filters its models, Then the configuration and Agent reply are visible", {
    timeout: 30_000,
}, async () => {
    const created = await createTestApp({ connectAgent: true });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    const composer = await created.queryElementByTestId(dataTestId.messageComposer);
    expect(composer).toBeInstanceOf(HTMLTextAreaElement);
    expect(composer).toHaveProperty("disabled", false);
    expect(created.optionalElementByTestId(dataTestId.pairingInstruction)).toBeNull();

    await created.user.click(await created.queryElementByTestId(dataTestId.agentConfiguration));
    await openAgentModelPicker(created);
    const search = await created.queryElementByTestId(dataTestId.modelSearch);
    await created.user.type(search, "large");
    await created.queryElementByTestId(
        dataTestId.sessionConfigValue("test-large"),
        (element) => element.textContent?.includes("Test Large") === true,
    );
    expect(created.optionalElementByTestId(dataTestId.sessionConfigValue("test-small"))).toBeNull();
    await created.user.keyboard("{Escape}{Escape}");

    const prompt = "Confirm the refreshed model settings";
    await sendPrompt(created, composer, prompt);
    await Promise.race([
        Promise.all([
            created.queryElementByTestId(
                dataTestId.userMessage,
                (element) => element.textContent?.includes(prompt) === true,
            ),
            created.waitForView(() => {
                const response = created
                    .elementsByTestId(dataTestId.agentResponse)
                    .find((element) => element.textContent?.includes(`Codex turn 1: ${prompt}`) === true);
                expect(response).toBeDefined();
                return response;
            }),
        ]),
        failure,
    ]);
    await created.waitForView(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
});

test("Given multiple Runtimes share a Project, When a user configures a paired Bot, Then only its Runtime harnesses are listed", {
    timeout: 30_000,
}, async () => {
    const created = await createTestApp({
        connectAgent: true,
        prepare: async (application) => {
            await application.connectRuntime();
        },
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await Promise.race([waitForConnection(created, "connected"), failure]);

    await created.user.click(await created.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });

    const harnesses = getByRole(configuration, "radiogroup", { name: "Harness" });
    expect(getAllByRole(harnesses, "radio", { name: "Codex" })).toHaveLength(1);
    expect(getAllByRole(harnesses, "radio", { name: "Pi" })).toHaveLength(1);
    expect(getAllByRole(harnesses, "radio")).toHaveLength(2);
    expect(getByRole(harnesses, "radio", { name: "Pi" }).getAttribute("aria-disabled")).toBe("true");
});

test("Given a Bot has a recent directory from another harness, When its Runtime configuration loads, Then the directory remains available", {
    timeout: 30_000,
}, async () => {
    const created = await createTestApp({
        connectAgent: true,
        prepare: (current) =>
            window.localStorage.setItem(
                `mobius:recent-cwd:${encodeURIComponent(current.botId)}`,
                JSON.stringify([{ directoryId: "saved-directory", directoryLabel: "/saved-by-another-harness" }]),
            ),
    });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));

    const menu = await Promise.race([
        (async () => {
            const workingDirectory = await created.queryElementByTestId(dataTestId.workingDirectory);
            await created.user.click(workingDirectory);
            return await created.queryElementByTestId(
                dataTestId.recentWorkingDirectory,
                (element) => element.textContent?.includes("/saved-by-another-harness") === true,
            );
        })(),
        failure,
    ]);

    expect(menu.textContent).toContain("/saved-by-another-harness");
});

test("Given the working directory browser is open, When the user edits the path, Then folder navigation is disabled until the preview settles", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const failure = app.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));

    await Promise.race([
        app.queryElementByTestId(
            dataTestId.botConnectionStatus,
            (element) => element.getAttribute("data-connection-status") === "connected",
        ),
        failure,
    ]);
    await app.user.click(await app.queryElementByTestId(dataTestId.workingDirectory));
    await app.user.click(await app.queryElementByTestId(dataTestId.changeWorkingDirectory));

    const path = await app.queryElementByTestId(dataTestId.workingDirectoryPath);
    const preview = await app.queryElementByTestId(dataTestId.workingDirectoryPreview);
    const navigation = getAllByRole(preview, "button")[0];
    if (!(path instanceof HTMLInputElement) || !(navigation instanceof HTMLButtonElement)) {
        throw new Error("Expected working directory path and folder navigation controls");
    }
    expect(navigation.disabled).toBe(false);

    await app.user.type(path, "/");
    expect(navigation.disabled).toBe(true);

    await Promise.race([
        app.waitForView(() => {
            const settledNavigation = getAllByRole(
                app.elementByTestId(dataTestId.workingDirectoryPreview),
                "button",
            )[0];
            if (!(settledNavigation instanceof HTMLButtonElement)) {
                throw new Error("Expected settled folder navigation controls");
            }
            expect(settledNavigation.disabled).toBe(false);
            return settledNavigation;
        }),
        failure,
    ]);

    await app.user.type(path, "/missing-cwd-preview");
    const failedNavigation = getAllByRole(app.elementByTestId(dataTestId.workingDirectoryPreview), "button")[0];
    if (!(failedNavigation instanceof HTMLButtonElement)) {
        throw new Error("Expected folder navigation controls during failed preview");
    }
    expect(failedNavigation.disabled).toBe(true);

    await Promise.race([
        app.waitForView(() => {
            const failedPreview = app.elementByTestId(dataTestId.workingDirectoryPreview);
            expect(getByRole(failedPreview, "alert")).toBeDefined();
            const settledNavigation = getAllByRole(failedPreview, "button")[0];
            if (!(settledNavigation instanceof HTMLButtonElement)) {
                throw new Error("Expected folder navigation controls after failed preview");
            }
            expect(settledNavigation.disabled).toBe(false);
            return settledNavigation;
        }),
        failure,
    ]);
});

test("Given a Bot paired with the Claude harness, When the user opens its settings, Then the Claude brand mark labels the harness field and the trigger", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, agent: { id: "claude", label: "Claude Code" } });
    await waitForConnection(app, "connected");

    const triggerMark = await app.queryElementByTestId(
        dataTestId.harnessTriggerMark,
        (element) => element.getAttribute("data-harness-product") === "claude",
    );
    expect(triggerMark.getAttribute("aria-hidden")).toBe("true");
    expect(triggerMark.tagName).toBe("svg");

    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    const harness = getByRole(configuration, "radio", { name: "Claude Code", checked: true });
    expect(harness.textContent).toContain("Claude Code");
    const harnessMark = app.elementByTestId(dataTestId.harnessMark, harness);
    expect(harnessMark.getAttribute("data-harness-product")).toBe("claude");
    expect(harnessMark.getAttribute("aria-hidden")).toBe("true");
    expect(harnessMark.tagName === "svg" || harnessMark.querySelector("svg")).toBeTruthy();
});

test("Given a paired Bot, When the composer controls are visible, Then the configuration trigger shows its harness mark without repeating the harness or machine name", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );

    const configurationTrigger = await app.queryElementByTestId(dataTestId.agentConfiguration);
    expect(configurationTrigger.textContent).toContain("Test Small");
    expect(configurationTrigger.textContent).not.toContain("Codex");
    expect(configurationTrigger.textContent).not.toContain("Controlled Agent Runtime");
    expect(configurationTrigger.querySelector(".lucide-sliders-horizontal")).toBeNull();
    expect(app.elementByTestId(dataTestId.harnessTriggerMark, configurationTrigger)).toBeDefined();
});

test("Given a Bot paired with an unlisted harness, When the user opens its settings, Then a generic mark labels the harness field without renaming it", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, agent: { id: "unlisted-agent", label: "Unlisted Agent" } });
    await waitForConnection(app, "connected");

    const triggerMark = await app.queryElementByTestId(
        dataTestId.harnessTriggerMark,
        (element) => element.getAttribute("data-harness-product") === "generic",
    );
    expect(triggerMark.getAttribute("aria-hidden")).toBe("true");

    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    const harness = getByRole(configuration, "radio", { name: "Unlisted Agent", checked: true });
    expect(harness.textContent).toContain("Unlisted Agent");
    expect(app.elementByTestId(dataTestId.harnessMark, harness).getAttribute("data-harness-product")).toBe("generic");
    const harnesses = getByRole(configuration, "radiogroup", { name: "Harness" });
    expect(getAllByRole(harnesses, "radio", { name: "Unlisted Agent" })).toHaveLength(1);
    expect(getByRole(harnesses, "radio", { name: "Pi" }).getAttribute("aria-disabled")).toBe("true");
});

test("Given a Bot paired with Pi, When the user opens its settings and sends a prompt, Then Pi and its streamed reply are visible", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, agent: { id: "pi", label: "Pi" } });
    await waitForConnection(app, "connected");
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    expect(getByRole(configuration, "radio", { name: "Pi", checked: true }).textContent).toContain("Pi");
    await app.user.keyboard("{Escape}");
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error("Expected composer");
    }
    const prompt = "Reply through the Pi integration";
    await sendPrompt(app, composer, prompt);
    await app.waitForView(() => {
        const reply = app
            .elementsByTestId(dataTestId.agentResponse)
            .find((element) => element.textContent?.includes(prompt));
        expect(reply).toBeDefined();
        return reply;
    });
});

test("Given another tab saved a recent directory, When this tab reopens its directory menu and forgets a directory, Then the other tab's directory is listed and remains", {
    timeout: 30_000,
}, async () => {
    const key = (botId: string) => `mobius:recent-cwd:${encodeURIComponent(botId)}`;
    const here = { directoryId: "directory-here", directoryLabel: "/project-here" };
    const there = { directoryId: "directory-there", directoryLabel: "/project-from-another-tab" };
    const app = await createTestApp({
        connectAgent: true,
        prepare: (current) => window.localStorage.setItem(key(current.botId), JSON.stringify([here])),
    });
    const recent = (label: string) =>
        app.elementsByTestId(dataTestId.recentWorkingDirectory).some((item) => item.textContent?.includes(label));

    await app.user.click(await app.queryElementByTestId(dataTestId.workingDirectory));
    await app.waitForView(() => expect(recent("/project-here")).toBe(true));
    // Another tab of the same Bot saves a directory through the same storage.
    window.localStorage.setItem(key(app.botId), JSON.stringify([there, here]));
    // Reopening the menu shows it, with no change made in this tab.
    await app.user.keyboard("{Escape}");
    await app.user.click(await app.queryElementByTestId(dataTestId.workingDirectory));
    await app.waitForView(() => expect(recent("/project-from-another-tab")).toBe(true));
    const forget = app
        .elementsByTestId(dataTestId.forgetRecentWorkingDirectory)
        .find((element) => element.getAttribute("aria-label")?.includes("/project-here") === true);
    if (forget === undefined) {
        throw new Error("Expected to forget /project-here");
    }
    await app.user.click(forget);
    await app.user.keyboard("{Escape}");

    await app.user.click(await app.queryElementByTestId(dataTestId.workingDirectory));
    await app.waitForView(() => expect(recent("/project-from-another-tab")).toBe(true));
    expect(recent("/project-here")).toBe(false);
});
