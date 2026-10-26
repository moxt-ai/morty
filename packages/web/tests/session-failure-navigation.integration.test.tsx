import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given an unavailable saved session, When opening it fails, Then navigation remains available and New Session lets the user send a new prompt", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        page: { kind: "managed-session", sessionId: "chat_unavailable_session" },
    });
    await app.waitForView(() => getByRole(document.body, "button", { name: "Reconnect" }));
    expect(getByRole(document.body, "button", { name: "Open Session" })).toBeDefined();
    await app.user.click(getByRole(document.body, "button", { name: "New Session" }));
    const composer = await app.queryElementByTestId(dataTestId.messageComposer);
    await sendPrompt(app, composer, "Continue in a new session");
    await app.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Codex turn 1: Continue in a new session",
        ),
    );
    expect(queryByRole(document.body, "button", { name: "Reconnect" })).toBeNull();
    expect(new URL(window.location.href).searchParams.get("sessionId")).not.toBe("chat_unavailable_session");
});
