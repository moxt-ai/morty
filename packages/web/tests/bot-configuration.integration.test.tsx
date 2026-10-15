import { fireEvent, getAllByRole, getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given Morty has no paired agent, When the connect dialog opens, Then the pairing instruction is a read-only multiline field with an icon refresh control", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    const pairing = await app.queryElementByTestId(dataTestId.pairingInstruction);
    const refresh = getByRole(document.body, "button", { name: "Refresh pairing instruction" });

    expect(pairing).toBeInstanceOf(HTMLTextAreaElement);
    expect(pairing).toHaveProperty("readOnly", true);
    expect(pairing.getAttribute("rows")).toBe("3");
    expect(refresh.textContent).toBe("");
});

test("Given a selected Machine, When a user opens its settings and renames it, Then the new name is visible in the selector", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await app.user.click(await app.queryElementByTestId(dataTestId.botMenuTrigger));

    expect(queryByRole(document.body, "button", { name: "Connect another agent" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Pair the machine" })).toBeNull();
    expect(queryByRole(document.body, "button", { name: "Rename machine" })).toBeNull();
    await app.user.keyboard("{Escape}");
    await app.user.click(getByRole(document.body, "button", { name: "Configure My Machine" }));

    const name = getByRole(document.body, "textbox", { name: "Machine name" });
    expect(name).toBeInstanceOf(HTMLInputElement);
    expect((name as HTMLInputElement).value).toBe("My Machine");
    await app.user.clear(name);
    await app.user.type(name, "Studio Machine");
    await app.user.click(getByRole(document.body, "button", { name: "Rename Machine" }));

    await app.queryElementByTestId(
        dataTestId.botMenuTrigger,
        (element) => element.textContent?.includes("Studio Machine") === true,
    );
    await app.user.click(app.elementByTestId(dataTestId.botMenuTrigger));
    expect(getByRole(document.body, "button", { name: "Studio Machine" })).toBeDefined();
});

test("Given an existing Machine, When the user opens another agent instruction and closes or reloads Chat without pairing, Then no additional Machine is created", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    if (app.optionalElementByTestId(dataTestId.closeDialog)) {
        await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    }
    for (const leave of ["close", "reload"] as const) {
        await app.user.click(await app.queryElementByTestId(dataTestId.botMenuTrigger));
        await app.user.click(getByRole(document.body, "button", { name: "Connect another agent" }));
        expect(await app.queryElementByTestId(dataTestId.pairingInstruction)).toBeInstanceOf(HTMLTextAreaElement);
        expect(queryByRole(document.body, "textbox", { name: "Machine name" })).toBeNull();
        expect(queryByRole(document.body, "textbox", { name: "Connection name" })).toBeNull();
        if (leave === "reload") {
            app.remount();
            await app.queryElementByTestId(dataTestId.botMenuTrigger);
            await app.user.click(await app.queryElementByTestId(dataTestId.botMenuTrigger));
            await app.user.click(getByRole(document.body, "button", { name: "Connect another agent" }));
            await app.queryElementByTestId(dataTestId.pairingInstruction);
        }
        await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
        await app.user.click(await app.queryElementByTestId(dataTestId.botMenuTrigger));
        expect(getByRole(document.body, "button", { name: "My Machine" })).toBeDefined();
        expect(queryByRole(document.body, "button", { name: "My Machine 2" })).toBeNull();
        expect(app.optionalElementByTestId(dataTestId.removeBot)).toBeNull();
        await app.user.keyboard("{Escape}");
    }
});

test("Given an additional-agent instruction, When the agent redeems it and connects, Then Chat selects the new Machine and retains the existing one", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    if (app.optionalElementByTestId(dataTestId.closeDialog)) {
        await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    }
    await app.user.click(await app.queryElementByTestId(dataTestId.botMenuTrigger));
    await app.user.click(getByRole(document.body, "button", { name: "Connect another agent" }));
    const instruction = await app.queryElementByTestId(dataTestId.pairingInstruction);
    if (!(instruction instanceof HTMLTextAreaElement)) {
        throw new Error("Expected the pairing instruction");
    }
    await app.connectAgent({ id: "codex", label: "Codex" }, undefined, instruction.value);
    await app.queryElementByTestId(
        dataTestId.botMenuTrigger,
        (element) => element.textContent?.includes("My Machine 2") === true,
    );
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    expect(queryByRole(document.body, "dialog", { name: "Connect another agent" })).toBeNull();
    await app.user.click(await app.queryElementByTestId(dataTestId.botMenuTrigger));
    expect(getByRole(document.body, "button", { name: "My Machine" })).toBeDefined();
    expect(getByRole(document.body, "button", { name: "My Machine 2" })).toBeDefined();
});

test("Given Morty has no paired agent, When its data region is changing, Then its pairing instruction cannot be used", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp();
    const pairing = await app.queryElementByTestId(dataTestId.pairingInstruction);
    const copy = getByRole(document.body, "button", { name: "Copy pairing instruction" });
    const region = getByRole(document.body, "combobox", { name: "Data region" });
    if (!(pairing instanceof HTMLTextAreaElement) || !(copy instanceof HTMLButtonElement)) {
        throw new Error("Expected pairing instruction controls");
    }
    expect(pairing.disabled).toBe(false);
    expect(copy.disabled).toBe(false);

    await app.user.click(region);
    act(() => fireEvent.click(getByRole(document.body, "option", { name: "Eastern North America" })));
    expect(document.body.textContent).toContain("Moving Morty data");

    expect(pairing.disabled).toBe(true);
    expect(copy.disabled).toBe(true);
    await vi.waitFor(() => {
        expect(region).toHaveProperty("disabled", false);
        expect(document.body.textContent).toContain("Changing region resets Morty data");
    });
});

test("Given a paired Machine, When its Runtime disconnects, Then the Machine menu does not offer pairing", {
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
        (element) => element.textContent?.includes("Disconnected") === true,
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.closeDialog));
    await app.user.click(await app.queryElementByTestId(dataTestId.botMenuTrigger));

    expect(app.optionalElementByTestId(dataTestId.pairBotAgain)).toBeNull();
});

test("Given a paired Bot with cached agent settings, When a user filters its models, Then the configuration and Agent reply are visible", {
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

test("Given a paired Bot, When the composer controls are visible, Then the configuration trigger shows its harness mark without repeating the harness or machine name", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );

    const configurationTrigger = await app.queryElementByTestId(dataTestId.agentConfiguration);
    expect(configurationTrigger.textContent).toContain("Test Small");
    expect(configurationTrigger.textContent).not.toContain("Codex");
    expect(configurationTrigger.textContent).not.toContain("Controlled Agent Runtime");
    expect(configurationTrigger.querySelector(".lucide-sliders-horizontal")).toBeNull();
    expect(app.elementByTestId(dataTestId.harnessTriggerMark, configurationTrigger)).toBeDefined();
});

test("Given a Bot paired with an unlisted harness, When the user opens its settings, Then a generic mark labels the harness tab without renaming it", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true, agent: { id: "unlisted-agent", label: "Unlisted Agent" } });
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
    const tab = getByRole(configuration, "tab", { name: "Unlisted Agent" });
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
