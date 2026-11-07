import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifiedRelease } from "./release-artifact.mjs";

const release = await verifiedRelease();
const directory = await mkdtemp(join(tmpdir(), "morty-acceptance-"));
const npm = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].find((candidate) => candidate !== undefined && existsSync(candidate));
if (npm === undefined) {
    throw new Error("The selected Node installation must include npm");
}
const install = (...args) => execFileSync(process.execPath, [npm, ...args], { stdio: "inherit", timeout: 180000 });

try {
    install(
        "install",
        "--prefix",
        directory,
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        release.archive,
        "@moxt-ai/mobius@0.0.431",
    );
    execFileSync(
        process.execPath,
        [
            "--test",
            "packages/cli/tests/release/independent-product.test.mjs",
            "packages/cli/tests/release/coexistence.test.mjs",
        ],
        {
            stdio: "inherit",
            timeout: 600000,
            env: {
                ...process.env,
                MORTY_RELEASE_ARCHIVE: release.archive,
                MORTY_RELEASE_ENTRY: join(directory, "node_modules/@morty-build/cli/dist/cli.js"),
                MOXT_RELEASE_ENTRY: join(directory, "node_modules/@moxt-ai/mobius/dist/cli.js"),
            },
        },
    );
} finally {
    await rm(directory, { recursive: true, force: true });
}
