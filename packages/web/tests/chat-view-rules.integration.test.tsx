import { getByRole, queryByRole } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";

test("Given an Agent identifier containing a colon, When its conversation opens, Then configuration shows the Runtime's Agent label", {
    timeout: 60_000,
}, async () => {
    const app = await createTestApp({ agents: [{ id: "team:codex", label: "Team Codex" }], connectAgent: true });
    await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Work with the team Agent");
    await app.waitForView(() =>
        expect(
            app
                .elementsByTestId(dataTestId.agentResponse)
                .some((element) => element.textContent?.includes("Work with the team Agent")),
        ).toBe(true),
    );
    await app.user.click(await app.queryElementByTestId(dataTestId.agentConfiguration));
    const dialog = getByRole(document.body, "dialog", { name: "Agent configuration" });
    await app.waitForView(() => expect(getByRole(dialog, "heading", { name: "Team Codex" })).toBeDefined());
});

test("Given a conversation in Today, When local midnight passes without interaction, Then it moves to Yesterday", {
    timeout: 60_000,
}, async () => {
    const origin = "2026-10-10T23:59:59";
    const clock = new TestClock(origin);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(origin));
    try {
        const app = await createTestApp({ connectAgent: true, clock });
        await sendPrompt(app, await app.queryElementByTestId(dataTestId.messageComposer), "Before midnight");
        await app.waitForView(() => {
            expect(
                app
                    .elementsByTestId(dataTestId.agentResponse)
                    .some((element) => element.textContent?.includes("Before midnight")),
            ).toBe(true);
            expect(getByRole(document.body, "heading", { level: 3, name: "Today" })).toBeDefined();
        });
        await act(async () => {
            clock.advanceBy(1_000);
        });
        await app.waitForView(() => {
            expect(getByRole(document.body, "heading", { level: 3, name: "Yesterday" })).toBeDefined();
            expect(queryByRole(document.body, "heading", { level: 3, name: "Today" })).toBeNull();
        });
        await app.close();
    } finally {
        vi.useRealTimers();
    }
});
