import * as v from "valibot";
import { E2EHarness } from "./harness.ts";
import { LocalStack } from "./local-stack.ts";

export const publishableKey = "pk_test_c21hc2hpbmctc3BpZGVyLTg1NzQuY2xlcmsuYWNjb3VudHMuZGV2JA";

export function preparedPlatform() {
    const decoded: unknown = JSON.parse(process.env.MOBIUS_E2E_PREPARED_PLATFORM ?? "null");
    return v.parse(
        v.object({
            port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
            appId: v.pipe(v.string(), v.nonEmpty()),
            appSecret: v.pipe(v.string(), v.nonEmpty()),
        }),
        decoded,
    );
}

export default async function globalSetup() {
    const harness = await E2EHarness.create("chat-e2e-suite");
    try {
        const stack = await LocalStack.create(harness, {
            binary: process.execPath,
            xdgConfigHome: harness.workDirectory,
            publishableKey,
        });
        const application = await stack.startPlatform();
        await stack.buildChat(application);
        // Playwright passes global-setup environment values to every worker.
        process.env.MOBIUS_E2E_PREPARED_PLATFORM = JSON.stringify({ port: stack.platformPort, ...application });
        return async () => {
            delete process.env.MOBIUS_E2E_PREPARED_PLATFORM;
            await harness.close(true);
        };
    } catch (error) {
        try {
            await harness.diagnose(error);
        } finally {
            await harness.close(false);
        }
        throw error;
    }
}
