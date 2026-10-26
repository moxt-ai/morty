import { getByRole, getByText, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given an unavailable saved session, When opening it fails, Then its recovery explains the problem and starts a new session without an ineffective reconnect", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({
        connectAgent: true,
        page: { kind: "managed-session", sessionId: "chat_unavailable_session" },
    });
    const failure = await app.waitForView(() => getByRole(document.body, "alert"));
    expect(failure.textContent).toContain("Session unavailable");
    expect(failure.textContent).toContain("Open another session or start a new one.");
    expect(queryByRole(document.body, "button", { name: "Reconnect" })).toBeNull();
    const details = getByText(failure, "Technical details").closest("details");
    expect(details).toHaveProperty("open", false);
    await app.user.click(getByText(failure, "Technical details"));
    expect(details).toHaveProperty("open", true);
    expect(details?.textContent).toContain("NOT_FOUND");
    expect(getByRole(document.body, "button", { name: "Open Session" })).toBeDefined();
    await app.user.click(
        getByRole(getByRole(document.body, "log", { name: "Messages" }), "button", { name: "New Session" }),
    );
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

test("Given an imported native session is missing, When the user starts a new session from its error, Then reloading keeps the new conversation instead of importing the failed target", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(dataTestId.messageComposer);
    const url = new URL(window.location.href);
    url.searchParams.set("harness", "claude");
    url.searchParams.set("sessionId", "missing-native-session");
    url.searchParams.set("nativeSessionAction", "import");
    window.history.replaceState(null, "", url);
    const opened = await app.reload();
    await opened.waitForView(() => getByRole(document.body, "alert"));
    expect(queryByRole(document.body, "button", { name: "Fork session instead" })).toBeNull();
    await opened.user.click(
        getByRole(getByRole(document.body, "log", { name: "Messages" }), "button", { name: "New Session" }),
    );
    expect(new URL(window.location.href).searchParams.has("harness")).toBe(false);
    expect(new URL(window.location.href).searchParams.has("nativeSessionAction")).toBe(false);
    const composer = await opened.queryElementByTestId(dataTestId.messageComposer);
    await sendPrompt(opened, composer, "A fresh conversation");
    await opened.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Codex turn 1: A fresh conversation",
        ),
    );
    const reloaded = await opened.reload();
    await reloaded.waitForView(() =>
        expect(getByRole(document.body, "log", { name: "Messages" }).textContent).toContain(
            "Codex turn 1: A fresh conversation",
        ),
    );
});
