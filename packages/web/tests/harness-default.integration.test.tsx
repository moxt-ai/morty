import { getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

function harnessProduct(app: TestApp): string | null {
    return app
        .elementByTestId(dataTestId.harnessTriggerMark, app.elementByTestId(dataTestId.agentConfiguration))
        .getAttribute("data-harness-product");
}

async function waitForComposer(app: TestApp): Promise<void> {
    await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
}

async function waitForHarness(app: TestApp, product: string): Promise<void> {
    await app.waitForView(() => expect(harnessProduct(app)).toBe(product));
}

async function selectHarness(app: TestApp, name: string): Promise<void> {
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const configuration = getByRole(document.body, "dialog", { name: "Agent configuration" });
    await app.user.click(getByRole(configuration, "tab", { name }));
    await app.user.keyboard("{Escape}");
}

async function configureModel(app: TestApp, value: string): Promise<void> {
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    await app.user.click(
        await app.queryElementByTestId(
            dataTestId.agentSetting("model"),
            (element) => element instanceof HTMLButtonElement && !element.disabled,
        ),
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.sessionConfigValue(value)));
    await app.user.keyboard("{Escape}");
}

async function startNewSession(app: TestApp): Promise<void> {
    await app.user.click(await app.queryElementByTestId(dataTestId.newConversation));
    await app.waitForView(() => expect(app.optionalElementByTestId(dataTestId.chatLanding)).not.toBeNull());
}

test("Given a Pi conversation is active, When the user starts a New Session, Then the draft keeps Pi and its model settings instead of the first connected harness, including after a reload", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({
        agents: [
            { id: "codex", label: "Codex" },
            { id: "pi", label: "Pi" },
        ],
        connectAgent: true,
    });
    await waitForComposer(app);
    // The Runtime lists Codex first, so an unremembered draft starts there.
    await waitForHarness(app, "codex");

    await selectHarness(app, "Pi");
    await waitForHarness(app, "pi");
    await sendPrompt(app, app.elementByTestId(dataTestId.messageComposer), "Work through Pi");
    await app.waitForView(() =>
        expect(
            app.elementsByTestId(dataTestId.agentResponse).some((element) => element.textContent?.includes("turn 1")),
        ).toBe(true),
    );
    await configureModel(app, "test-large");
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large"),
    );

    await startNewSession(app);
    await waitForHarness(app, "pi");
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large"),
    );

    // Choosing another harness for the draft must not override the harness of
    // the conversation the user then opens.
    await selectHarness(app, "Codex");
    await waitForHarness(app, "codex");
    const piConversation = await app.waitForView(() => {
        const conversation = app.elementsByTestId(dataTestId.managedConversation)[0];
        if (conversation === undefined) {
            throw new Error("Waiting for the Pi conversation in the sidebar");
        }
        return conversation;
    });
    await app.user.click(piConversation);
    await waitForComposer(app);
    await waitForHarness(app, "pi");

    await startNewSession(app);
    await waitForHarness(app, "pi");
    await app.waitForView(() =>
        expect(app.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large"),
    );

    const reloaded = await app.reload();
    await waitForComposer(reloaded);
    await reloaded.waitForView(() => expect(reloaded.optionalElementByTestId(dataTestId.chatLanding)).not.toBeNull());
    await reloaded.waitForView(() => expect(harnessProduct(reloaded)).toBe("pi"));
    await reloaded.waitForView(() =>
        expect(reloaded.elementByTestId(dataTestId.agentConfiguration).textContent).toContain("Test Large"),
    );
});
