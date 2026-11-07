import { resolve } from "node:path";
import cliPackage from "../../package.json" with { type: "json" };
import { runBoundedProcess } from "../../src/engine/util/process/executable.ts";

/** Install through the user's CLI boundary, using the archive built once by the test prehook. */
export async function installWorkspaceDaemonRelease(
    stateRoot: string,
    version = cliPackage.version,
    entry = resolve(import.meta.dirname, "../../dist/cli.js"),
): Promise<void> {
    if (version !== cliPackage.version) {
        throw new Error("A different release requires its own built archive");
    }
    const archive =
        process.env["MORTY_RELEASE_ARCHIVE"] ??
        resolve(import.meta.dirname, `../../../../.release/morty-build-cli-${version}.tgz`);
    await runBoundedProcess({
        command: process.execPath,
        arguments: [entry, "install", "--archive", archive],
        cwd: resolve(import.meta.dirname, "../.."),
        environment: { ...process.env, MORTY_STATE_DIRECTORY: stateRoot },
        signal: AbortSignal.timeout(120_000),
        timeoutMilliseconds: 120_000,
        outputLimitBytes: 65536,
    });
}

export function workspaceDaemonEnvironment(environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
    return { ...environment };
}
