import { fireEvent, getAllByRole, getByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { observeTestId, sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given an unpaired workspace, When a user manages Bots, Then pairing and the surviving Bot remain visible", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    const [landing, pairing] = await Promise.all([
        app.queryElementByTestId(dataTestId.chatLanding),
        app.queryElementByTestId(dataTestId.pairingInstruction),
    ]);
    expect(landing.textContent).toContain("My Machine");
    const conversationSetup = await app.queryElementByTestId(dataTestId.conversationSetupRequired);
    expect(conversationSetup.textContent).toContain("No conversations yet");
    expect(conversationSetup.textContent).toContain("Connect Machine");
    expect(conversationSetup.getAttribute("role")).not.toBe("alert");

    expect(pairing).toBeInstanceOf(HTMLInputElement);
    expect((pairing as HTMLInputElement).value).toMatch(/^follow http:\/\/127\.0\.0\.1:\d+\/pair\.md\?token=/u);

    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await app.user.click(await app.queryElementByTestId(dataTestId.botMenuTrigger));
    await app.user.click(await app.queryElementByTestId(dataTestId.createBot));
    const name = await app.queryElementByTestId(dataTestId.botNameInput);
    await app.user.type(name, "Laptop Bot");
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.confirmCreateBot,
            (element) => element instanceof HTMLButtonElement && !element.disabled,
        ),
    );
    await app.queryElementByTestId(
        dataTestId.botMenuTrigger,
        (element) => element.textContent?.includes("Laptop Bot") === true,
    );
    await app.user.click(app.elementByTestId(dataTestId.botMenuTrigger));
    await app.user.click(await app.queryElementByTestId(dataTestId.removeBot));
    await app.user.click(await app.queryElementByTestId(dataTestId.confirmRemoveBot));
    await app.queryElementByTestId(
        dataTestId.botMenuTrigger,
        (element) => element.textContent?.includes("My Machine") === true,
    );
    await app.user.click(app.elementByTestId(dataTestId.botMenuTrigger));
    expect(app.optionalElementByTestId(dataTestId.removeBot)).toBeNull();
});

test("Given an unpaired workspace, When a fresh workspace is being created in another region, Then its pairing instruction cannot be used", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    const pairing = await app.queryElementByTestId(dataTestId.pairingInstruction);
    const copy = getByRole(document.body, "button", { name: "Copy pairing instruction" });
    const region = getByRole(document.body, "combobox", { name: "Workspace region" });
    if (!(pairing instanceof HTMLInputElement) || !(copy instanceof HTMLButtonElement)) {
        throw new Error("Expected pairing instruction controls");
    }
    expect(pairing.disabled).toBe(false);
    expect(copy.disabled).toBe(false);

    await app.user.click(region);
    act(() => fireEvent.click(getByRole(document.body, "option", { name: "Eastern North America" })));
    expect(document.body.textContent).toContain("Creating a fresh workspace");

    expect(pairing.disabled).toBe(true);
    expect(copy.disabled).toBe(true);
    await vi.waitFor(() => {
        expect(region).toHaveProperty("disabled", false);
        expect(document.body.textContent).toContain("Changing region replaces this fresh workspace");
    });
});

test("Given a paired Bot with cached agent settings, When a user refreshes and filters its models, Then the reloaded configuration and Agent reply are visible", {
    timeout: 30_000,
}, async () => {
    const created = await createTestApp({ connectAgent: true });
    const failure = created.agentFailure ?? Promise.reject(new Error("The test Agent was not started."));
    await created.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const composer = await created.queryElementByTestId(dataTestId.messageComposer);
    expect(composer).toBeInstanceOf(HTMLTextAreaElement);
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
    expect(created.optionalElementByTestId(dataTestId.pairingInstruction)).toBeNull();

    await created.user.click(await created.queryElementByTestId(dataTestId.agentConfiguration));
    const loading = observeTestId(dataTestId.agentSettingsLoading);
    await created.user.click(await created.queryElementByTestId(dataTestId.refreshAgentSettings));
    await loading;
    await created.user.click(
        await created.queryElementByTestId(
            dataTestId.agentSetting("model"),
            (element) => element instanceof HTMLButtonElement && !element.disabled,
        ),
    );
    const search = await created.queryElementByTestId(dataTestId.modelSearch);
    await created.user.type(search, "large");
    await created.queryElementByTestId(
        dataTestId.sessionConfigValue("test-large"),
        (element) => element.textContent?.includes("Test Large") === true,
    );
    expect(created.optionalElementByTestId(dataTestId.sessionConfigValue("test-small"))).toBeNull();
    await created.user.keyboard("{Escape}{Escape}");

    const prompt = "Confirm the refreshed model settings";
    await sendPrompt(created, composer as HTMLTextAreaElement, prompt);
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
    await vi.waitFor(() => expect(created.optionalElementByTestId(dataTestId.sessionStatus)).toBeNull());
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
    await Promise.race([
        created.queryElementByTestId(
            dataTestId.botConnectionStatus,
            (element) => element.textContent?.includes("Connected") === true,
        ),
        failure,
    ]);

    await created.user.click(await created.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });

    expect(getAllByRole(configuration, "tab", { name: "Codex" })).toHaveLength(1);
    expect(getAllByRole(configuration, "tab")).toHaveLength(1);
});

test("Given a Bot has a recent directory from another harness, When its workspace loads, Then the directory remains available", {
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
            (element) => element.textContent?.includes("Connected") === true,
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

test("Given a Bot paired with the Claude harness, When the user opens its settings, Then the Claude brand mark labels the harness tab and the trigger", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, agent: { id: "claude", label: "Claude Code" } });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );

    const triggerMark = await app.queryElementByTestId(
        dataTestId.harnessTriggerMark,
        (element) => element.getAttribute("data-harness-product") === "claude",
    );
    expect(triggerMark.getAttribute("aria-hidden")).toBe("true");

    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    const tab = getByRole(configuration, "tab", { name: "Claude Code" });
    const tabMark = app.elementByTestId(dataTestId.harnessMark, tab);
    expect(tabMark.getAttribute("data-harness-product")).toBe("claude");
    expect(tabMark.getAttribute("aria-hidden")).toBe("true");
    expect(tabMark.querySelector("svg")).not.toBeNull();
});

test("Given a Bot paired with an unlisted harness, When the user opens its settings, Then a generic mark labels the harness tab without renaming it", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, agent: { id: "workbuddy", label: "WorkBuddy" } });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );

    const triggerMark = await app.queryElementByTestId(
        dataTestId.harnessTriggerMark,
        (element) => element.getAttribute("data-harness-product") === "generic",
    );
    expect(triggerMark.getAttribute("aria-hidden")).toBe("true");

    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    const tab = getByRole(configuration, "tab", { name: "WorkBuddy" });
    expect(app.elementByTestId(dataTestId.harnessMark, tab).getAttribute("data-harness-product")).toBe("generic");
    expect(getAllByRole(configuration, "tab")).toHaveLength(1);
});

test("Given a Bot paired with Pi, When the user opens its settings and sends a prompt, Then Pi and its streamed reply are visible", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, agent: { id: "pi", label: "Pi" } });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    expect(getByRole(configuration, "tab", { name: "Pi", selected: true })).toBeDefined();
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
