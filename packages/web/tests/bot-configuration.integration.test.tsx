import { getAllByRole, getByRole } from "@testing-library/dom";
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
    expect(landing.textContent).toContain("My Bot");
    const conversationSetup = await app.queryElementByTestId(dataTestId.conversationSetupRequired);
    expect(conversationSetup.textContent).toContain("No conversations yet");
    expect(conversationSetup.textContent).toContain("Connect Bot");
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
        (element) => element.textContent?.includes("My Bot") === true,
    );
    await app.user.click(app.elementByTestId(dataTestId.botMenuTrigger));
    expect(app.optionalElementByTestId(dataTestId.removeBot)).toBeNull();
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
