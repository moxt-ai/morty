import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import packageMetadata from "../../package.json" with { type: "json" };

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

async function runCli(
    arguments_: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "../../dist/cli.js"), ...arguments_], {
        env: environment,
        signal: AbortSignal.timeout(60_000),
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve_, reject) => {
        child.once("error", reject);
        child.once("exit", resolve_);
    });
    return { code, stderr, stdout };
}

/** A state root initialized by a real daemon, and the daemon data directory it created inside it. */
async function openedStateRoot(): Promise<{
    readonly root: string;
    readonly installation: string;
    readonly home: string;
}> {
    const home = await mkdtemp(join(tmpdir(), "morty-state-root-"));
    temporaryDirectories.push(home);
    const root = join(home, "state");
    const env = environment(home, root);
    try {
        const started = await runCli(["start"], env);
        expect(started.code, started.stderr).toBe(0);
    } finally {
        const stopped = await runCli(["quit"], env);
        expect(stopped.code, stopped.stderr).toBe(0);
    }
    const application = join(root, "computer");
    return { root, installation: application, home };
}

function environment(home: string, stateDirectory: string): NodeJS.ProcessEnv {
    return { HOME: home, MORTY_STATE_DIRECTORY: stateDirectory, PATH: dirname(process.execPath), TMPDIR: home };
}

describe("Morty state root", () => {
    it.each(["pair list", "start"])(
        "Given the installation directory is a symlink, When the user runs %s, Then the CLI or Worker refuses without creating connection state in the link target",
        async (command) => {
            const home = await mkdtemp(join(tmpdir(), "morty-version-container-"));
            temporaryDirectories.push(home);
            const root = join(home, "state");
            const target = join(home, "redirected");
            await mkdir(root, { recursive: true, mode: 0o700 });
            await mkdir(target, { mode: 0o700 });
            await symlink(target, join(root, "computer"), process.platform === "win32" ? "junction" : "dir");
            const env = environment(home, root);
            try {
                const result = await runCli(command === "start" ? ["start"] : ["pair", "list"], env);

                expect(result.code).not.toBe(0);
                expect(await readdir(target)).toEqual([]);
            } finally {
                if (command === "start") {
                    await runCli(["quit"], env);
                }
            }
        },
    );

    it.skipIf(process.platform === "win32")(
        "Given a user-owned installation directory allows other users to write, When the user lists pairings, Then the CLI makes the container private before initializing state",
        async () => {
            const home = await mkdtemp(join(tmpdir(), "morty-version-container-"));
            temporaryDirectories.push(home);
            const root = join(home, "state");
            await runCli(["pair", "list"], environment(home, root));
            const versionDirectory = join(root, "computer");
            await chmod(versionDirectory, 0o777);

            const listed = await runCli(["pair", "list"], environment(home, root));

            expect(listed.code, listed.stderr).toBe(0);
            expect((await stat(versionDirectory)).mode & 0o777).toBe(0o700);
        },
    );

    it("Given an Agent environment whose MORTY_STATE_DIRECTORY names an installation's data, When Morty runs there, Then it refuses with a configuration error that names the owning root and creates nothing inside that data", async () => {
        const { root, installation, home } = await openedStateRoot();
        const before = await readdir(installation);

        const listed = await runCli(["pair", "list"], environment(home, installation));

        expect(listed.code).toBe(78);
        expect(listed.stderr).toContain(`MORTY_STATE_DIRECTORY=${root}`);
        expect(await readdir(installation)).toEqual(before);
    });

    it("Given an installation's data where an earlier nested Morty only left control files, When Morty runs there, Then it still refuses instead of treating it as a root", async () => {
        const { root, installation, home } = await openedStateRoot();
        await mkdir(join(installation, "computer"), { recursive: true, mode: 0o700 });

        const listed = await runCli(["pair", "list"], environment(home, installation));

        expect(listed.code).toBe(78);
        expect(listed.stderr).toContain(`MORTY_STATE_DIRECTORY=${root}`);
    });

    it("Given leftover files nested inside daemon data, When Morty is directed there as a state root, Then it refuses and retains those files", async () => {
        const { installation, home } = await openedStateRoot();
        // A daemon that ran with this directory as its root recorded its current version data there.
        await mkdir(join(installation, "versions", packageMetadata.version), { recursive: true, mode: 0o700 });
        await writeFile(join(installation, "current-data.txt"), `versions/${packageMetadata.version}\n`, {
            mode: 0o600,
        });

        const listed = await runCli(["pair", "list"], environment(home, installation));

        expect(listed.code).not.toBe(0);
        expect(await readFile(join(installation, "current-data.txt"), "utf8")).toBe(
            `versions/${packageMetadata.version}\n`,
        );
    });
});
