import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { createTestApp, type TestApp } from "./infra/test-app.tsx";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

test("Given a Fork completes before Morty loses its response, When the user retries, Then the original Session is registered once and opened", {
    timeout: 60_000,
}, async () => {
    const environment = await createChatWorkerEnvironment(true);
    let application: TestApp | undefined;
    try {
        const app = await createTestApp({
            environment,
            connectAgent: true,
            nativeSessionIds: new Set(["fork-recovery-source"]),
        });
        application = app;
        await app.queryElementByTestId(
            dataTestId.botConnectionStatus,
            (element) => element.getAttribute("data-connection-status") === "connected",
        );
        await app.user.click(getByRole(document.body, "button", { name: "Open Session" }));
        await app.user.click(
            await app.waitForView(() => getByRole(document.body, "button", { name: "Native fork-recovery-source" })),
        );
        const dialog = await app.waitForView(() => getByRole(document.body, "dialog", { name: "Open Session" }));
        const fork = await app.waitForView(() => {
            const button = getByRole(dialog, "button", { name: "Fork" });
            expect(button).not.toHaveProperty("disabled", true);
            return button;
        });
        if (app.network === null) {
            throw new Error("The scenario requires a real response-loss proxy");
        }
        const lost = app.network.interruptNextFork();
        await app.user.click(fork);
        expect(await lost).toBe(200);
        await app.waitForView(() => getByRole(dialog, "alert"));
        const managed = async (): Promise<unknown> => {
            const response = await app.transport.fetch(
                new Request(
                    `${app.origin}/morty/api/chat/projects/${app.identity.projectId}/bots/${app.botId}/managed-sessions`,
                    {
                        method: "POST",
                        headers: {
                            authorization: `Bearer ${await app.identity.getToken(new AbortController().signal)}`,
                        },
                    },
                ),
            );
            expect(response.status).toBe(200);
            return await response.json();
        };
        expect(await managed()).toEqual({ sessions: [] });
        await app.user.click(getByRole(dialog, "button", { name: "Fork" }));
        await app.waitForView(() => expect(queryByRole(document.body, "dialog", { name: "Open Session" })).toBeNull());
        expect(await managed()).toMatchObject({ sessions: [{ title: "Native fork-recovery-source (Fork #1)" }] });
    } finally {
        await application?.close();
        await environment.close();
    }
});
