import { getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

async function waitForConnectedComposer(app: TestApp): Promise<void> {
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === "connected",
    );
    await app.queryElementByTestId(
        dataTestId.messageComposer,
        (element) => element instanceof HTMLTextAreaElement && !element.disabled,
    );
}

async function openAgentConfiguration(app: TestApp): Promise<HTMLElement> {
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    return getByRole(document.body, "dialog", { name: "Agent configuration" });
}

test("Given a draft whose Runtime does not offer Pi, When the Runtime restarts offering Pi, Then the draft harness picker offers Pi without a reload", {
    timeout: 45_000,
}, async () => {
    const app = await createTestApp({ agents: [{ id: "codex", label: "Codex" }], connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await waitForConnectedComposer(app);
    const before = await openAgentConfiguration(app);
    expect(getByRole(before, "tab", { name: "Pi" }).getAttribute("data-installed")).toBe("false");
    await app.user.keyboard("{Escape}");

    await daemon.replaceAgents([
        { id: "codex", label: "Codex" },
        { id: "pi", label: "Pi" },
    ]);
    await waitForConnectedComposer(app);

    const after = await openAgentConfiguration(app);
    // The Worker checks the Runtime every 5 s and retries a failed check 5 s later, so the change can take two checks.
    await app.waitForView(() => {
        const pi = getByRole(after, "tab", { name: "Pi" });
        expect(pi.getAttribute("data-installed")).toBe("true");
        expect(pi.hasAttribute("disabled")).toBe(false);
    }, 20_000);
});
