import { dataTestId } from "../web/src/data-testid.ts";
import { expect, test } from "./infra/test.ts";

for (const mode of ["pair", "setup"]) {
    test(`Given a user following ${mode}.md, When they pair, chat and reload, Then the agent replies without re-pairing`, async ({
        runtime,
    }) => {
        const { page } = runtime;
        if (mode === "pair") {
            const originalIdentity = await runtime.openChat();
            const instruction = await page.getByTestId(dataTestId.pairingInstruction).inputValue();
            expect(instruction).toMatch(/^follow /u);
            const connected = await runtime.followInstructions(instruction.slice("follow ".length));
            expect(connected.identity).toEqual(originalIdentity);
            expect(connected.botId).toBe(originalIdentity.botId);
            expect(connected.url).toBe(runtime.origin);
            await page.reload();
        } else {
            const sessionId = "setup-source-session";
            await runtime.seedNativeSession(sessionId, "Continue this setup session");
            const connected = await runtime.followInstructions("/setup.md", sessionId);
            expect(connected.botId).toBe(connected.identity.botId);
            expect(new URL(connected.url).pathname).toBe("/continue");
            expect(new URL(connected.url).searchParams.get("harness")).toBe("opencode");
            expect(new URL(connected.url).searchParams.get("sessionId")).toBe(sessionId);
            expect(connected.expiresAt).toBeTruthy();
            const [continuation] = await Promise.all([
                page.waitForResponse(
                    (response) =>
                        response.request().method() === "POST" &&
                        new URL(response.url()).pathname.endsWith("/continue-native-session"),
                ),
                page.goto(connected.url),
            ]);
            expect(continuation.status()).toBe(200);
            expect(await continuation.json()).toMatchObject({
                result: {
                    action: "attach",
                    ready: { restored: true },
                },
            });
            await expect(page.getByRole("log", { name: "Local session messages", exact: true })).toContainText(
                "Continue this setup session",
            );
        }

        const composer =
            mode === "pair"
                ? page.getByTestId(dataTestId.messageComposer)
                : page.getByRole("textbox", { name: "Message local session", exact: true });
        await expect(composer).toBeVisible();
        await page.reload();
        await expect(composer).toBeVisible();
        await expect(page.getByTestId(dataTestId.pairingInstruction)).toHaveCount(0);

        const prompt = `Hello from the ${mode}.md journey`;
        if (mode === "pair") {
            await runtime.sendMessage(prompt);
            await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText(prompt);
            await expect(page.getByTestId(dataTestId.userMessage).last()).toHaveText(prompt);
        } else {
            await composer.fill(prompt);
            await page.getByRole("button", { name: "Send to local session", exact: true }).click();
            await expect(page.getByRole("log", { name: "Local session messages", exact: true })).toContainText(prompt);
        }
        const conversationUrl = page.url();

        await test.step("Reload the same conversation and receive a fresh reply without re-pairing", async () => {
            await page.reload();
            if (mode === "pair") {
                await expect(page.getByTestId(dataTestId.agentResponse).first()).toContainText(prompt);
            } else {
                await expect(page.getByRole("log", { name: "Local session messages", exact: true })).toContainText(
                    prompt,
                );
            }
            expect(page.url()).toBe(conversationUrl);
            await expect(page.getByTestId(dataTestId.pairingInstruction)).toHaveCount(0);
            const followUp = `Still connected after reloading ${mode}.md`;
            if (mode === "pair") {
                await runtime.sendMessage(followUp);
                await expect(page.getByTestId(dataTestId.agentResponse).nth(1)).toContainText(followUp);
                await expect(page.getByTestId(dataTestId.userMessage).last()).toHaveText(followUp);
            } else {
                await composer.fill(followUp);
                await page.getByRole("button", { name: "Send to local session", exact: true }).click();
                await expect(page.getByRole("log", { name: "Local session messages", exact: true })).toContainText(
                    followUp,
                );
            }
            expect(page.url()).toBe(conversationUrl);
        });
    });
}
