import { test as base } from "@playwright/test";
import { E2EHarness } from "./harness.ts";
import { createTestRuntime } from "./test-runtime.ts";

export { expect } from "@playwright/test";

function agentTest(agentId: "claude" | "opencode" | "pi") {
    return base.extend<{ readonly runtime: Awaited<ReturnType<typeof createTestRuntime>> }>({
        // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture dependency list.
        runtime: async ({}, use, testInfo) => {
            const harness = await E2EHarness.create("chat-e2e");
            let failure: unknown;
            try {
                await use(await createTestRuntime(harness, agentId));
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

export const test = agentTest("opencode");
export const claudeTest = agentTest("claude");
export const piTest = agentTest("pi");
