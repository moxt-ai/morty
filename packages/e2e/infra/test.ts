import { test as base, expect, type Page } from "@playwright/test";
import { E2EHarness } from "./harness.ts";
import { createTestComputer } from "./test-computer.ts";

export { expect } from "@playwright/test";

/**
 * Waits for the opened conversation to finish loading its messages. Its composer is already enabled while they load,
 * so an enabled composer alone does not mean the conversation a scenario starts from is open.
 */
export async function conversationLoaded(page: Page): Promise<void> {
    await expect(
        page.getByRole("log", { name: "Messages" }).getByRole("status", { name: "Loading messages" }),
    ).toBeHidden();
}

function computerTest() {
    return base.extend<{
        readonly computer: Awaited<ReturnType<typeof createTestComputer>>;
        readonly computerMachineName: string;
        readonly computerAgent: { readonly harness: string; readonly name: string };
    }>({
        computerMachineName: ["Browser test Computer", { option: true }],
        computerAgent: [{ harness: "claude", name: "Claude Code" }, { option: true }],
        computer: async ({ browserName, contextOptions, computerMachineName, computerAgent }, use, testInfo) => {
            const harness = await E2EHarness.create("chat-e2e");
            let failure: unknown;
            try {
                const computer = await createTestComputer(
                    harness,
                    browserName,
                    contextOptions,
                    computerMachineName,
                    computerAgent,
                );
                try {
                    await Promise.race([use(computer), computer.failure]);
                } finally {
                    await computer.close();
                }
            } catch (error) {
                failure = error;
                throw error;
            } finally {
                const success = failure === undefined && testInfo.status === testInfo.expectedStatus;
                if (!success) {
                    await harness.diagnose(failure ?? testInfo.error);
                }
                await harness.close(success);
            }
        },
    });
}

export const test = computerTest();
