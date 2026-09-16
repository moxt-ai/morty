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
            const connected = await runtime.followInstructions("/setup.md");
            expect(connected.botId).toBe(connected.identity.botId);
            expect(new URL(connected.url).pathname).toBe("/continue");
            expect(connected.expiresAt).toBeTruthy();
            await page.goto(connected.url);
        }

        const composer = page.getByTestId(dataTestId.messageComposer);
        await expect(composer).toBeVisible();
        await page.reload();
        await expect(composer).toBeVisible();
        await expect(page.getByTestId(dataTestId.pairingInstruction)).toHaveCount(0);

        const prompt = `Hello from the ${mode}.md journey`;
        await runtime.sendMessage(prompt);
        const reply = page.getByTestId(dataTestId.agentResponse).first();
        await expect(reply).toContainText(prompt);
        await expect(page.getByTestId(dataTestId.userMessage).last()).toHaveText(prompt);
        const conversationUrl = page.url();

        await test.step("Reload the same conversation and receive a fresh reply without re-pairing", async () => {
            await page.reload();
            await expect(reply).toContainText(prompt);
            expect(page.url()).toBe(conversationUrl);
            await expect(page.getByTestId(dataTestId.pairingInstruction)).toHaveCount(0);
            const followUp = `Still connected after reloading ${mode}.md`;
            await runtime.sendMessage(followUp);
            await expect(page.getByTestId(dataTestId.agentResponse).nth(1)).toContainText(followUp);
            await expect(page.getByTestId(dataTestId.userMessage).last()).toHaveText(followUp);
            expect(page.url()).toBe(conversationUrl);
        });
    });
}
