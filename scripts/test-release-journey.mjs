import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildLocalStack } from "../packages/e2e/infra/build.ts";
import { runE2E } from "../packages/e2e/infra/harness.ts";
import { LocalStack } from "../packages/e2e/infra/local-stack.ts";
import { verifiedRelease } from "./release-artifact.mjs";

const release = await verifiedRelease();
const metadata = JSON.parse(await readFile("packages/cli/package.json", "utf8"));
metadata.version = release.version;
await writeFile("packages/cli/package.json", `${JSON.stringify(metadata, null, 4)}\n`);
await runE2E("accepted-release", async (harness) => {
    await buildLocalStack(harness);
    const stack = await LocalStack.create(harness);
    const application = await stack.start();
    // A release verifies production with this check after activation; run it on this
    // revision's relay first, so a route or contract change fails before merging.
    await harness.stage("verify-deployment-checks", () =>
        harness.run(
            "node",
            [
                resolve("deployment/verify-session-access.ts"),
                "--origin",
                stack.chatOrigin,
                "--evidence",
                join(harness.workDirectory, "session-access-evidence.json"),
            ],
            {
                env: {
                    MORTY_SESSION_SIGNING_SECRET: application.sessionSigningSecret,
                    EXPECTED_REVISION: release.revision,
                },
            },
        ),
    );
    await harness.run(process.execPath, [
        resolve("packages/e2e/release-acceptance.mjs"),
        stack.chatOrigin,
        release.archive,
        "accepted-release",
    ]);
});
