import { test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";

async function waitForConnectionStatus(app: TestApp, status: "connected" | "disconnected"): Promise<void> {
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.getAttribute("data-connection-status") === status,
    );
}

test("Given a draft whose Runtime goes offline as the page loads, When it comes back, Then the status follows both changes without a reload", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    const daemon = app.daemon;
    if (daemon === null) {
        throw new Error("Expected a connected controlled Agent Runtime");
    }
    await waitForConnectionStatus(app, "connected");

    // The page read the Runtime as online just before this; the change must still reach it.
    await daemon.disconnect();
    await waitForConnectionStatus(app, "disconnected");

    await daemon.reconnect();
    await waitForConnectionStatus(app, "connected");
});
