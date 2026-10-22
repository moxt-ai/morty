import { getByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { createTestApp } from "./infra/test-app.tsx";

test("Given the component library, When the user opens the session agent tabs specimen and selects an agent, Then the selected agent is visible", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        page: { kind: "component-library", entryId: "session-agent-tabs" },
    });
    const tablist = await app.waitForView(() =>
        getByRole(document.body, "tablist", {
            name: "Session agent",
        }),
    );
    const codex = getByRole(tablist, "tab", { name: "Codex" });
    const claude = getByRole(tablist, "tab", { name: "Claude Code" });

    expect(codex.getAttribute("aria-selected")).toBe("true");
    await app.user.click(claude);
    expect(claude.getAttribute("aria-selected")).toBe("true");
});
