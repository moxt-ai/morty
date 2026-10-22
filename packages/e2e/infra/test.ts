import { test as base } from "@playwright/test";
import { E2EHarness } from "./harness.ts";
import { createTestRuntime } from "./test-runtime.ts";

export { expect } from "@playwright/test";

function runtimeTest() {
    return base.extend<{
        readonly runtime: Awaited<ReturnType<typeof createTestRuntime>>;
        readonly runtimeMachineName: string;
        readonly runtimeAgent: { readonly id: string; readonly name: string };
    }>({
        runtimeMachineName: ["Browser test Runtime", { option: true }],
        runtimeAgent: [{ id: "claude", name: "Claude Code" }, { option: true }],
        runtime: async ({ browserName, contextOptions, runtimeMachineName, runtimeAgent }, use, testInfo) => {
            const harness = await E2EHarness.create("chat-e2e");
            let failure: unknown;
            try {
                const runtime = await createTestRuntime(
                    harness,
                    browserName,
                    contextOptions,
                    runtimeMachineName,
                    runtimeAgent,
                );
                try {
                    await Promise.race([use(runtime), runtime.failure]);
                } finally {
                    await runtime.close();
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

export const test = runtimeTest();
