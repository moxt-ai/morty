import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, realpath, rm, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
async function installedEntry() {
    if (process.env.MORTY_RELEASE_ENTRY) {
        return process.env.MORTY_RELEASE_ENTRY;
    }
    for (const bin of (process.env.PATH ?? "").split(delimiter)) {
        const candidate = join(bin, "..", "@morty-build", "cli", "dist", "cli.js");
        try {
            await access(candidate);
            return await realpath(candidate);
        } catch {
            /* Try the next npm bin directory. */
        }
    }
    throw new Error("Run the release test with the packed Morty package installed on PATH");
}
const entry = await installedEntry();
if (!entry) {
    throw new Error("MORTY_RELEASE_ENTRY must identify the installed release entrypoint");
}

test("Given an existing Mobius state root, Morty help identifies its own product without changing that root", async () => {
    const existing = await mkdtemp(join(tmpdir(), "moxt-coexistence-"));
    const morty = await mkdtemp(join(tmpdir(), "morty-release-"));
    try {
        await writeFile(join(existing, "owned-by-moxt"), "preserve this installation\n");
        const result = await execute(process.execPath, [entry, "--help"], {
            env: { ...process.env, MORTY_STATE_DIRECTORY: morty, MOBIUS_STATE_DIRECTORY: existing },
            timeout: 20_000,
        });
        assert.match(result.stdout, /^Usage: morty\b/m);
        assert.doesNotMatch(result.stdout, /\bmobius\b/i);
        assert.deepEqual(await readdir(existing), ["owned-by-moxt"]);
    } finally {
        await rm(morty, { recursive: true, force: true });
        await rm(existing, { recursive: true, force: true });
    }
});

test("Given a packed Morty release, installation and daemon lifecycle preserve adjacent Moxt data and a failed update preserves the installed release", async () => {
    const archive = process.env.MORTY_RELEASE_ARCHIVE;
    assert.ok(archive, "MORTY_RELEASE_ARCHIVE is required");
    const existing = await mkdtemp(join(tmpdir(), "moxt-lifecycle-"));
    const morty = await mkdtemp(join(tmpdir(), "morty-lifecycle-"));
    const env = { ...process.env, MORTY_STATE_DIRECTORY: morty, MOBIUS_STATE_DIRECTORY: existing };
    const run = (...args) => execute(process.execPath, [entry, ...args], { env, timeout: 180_000 });
    try {
        await writeFile(join(existing, "owned-by-moxt"), "preserve this installation\n");
        await run("install", "--archive", archive);
        await Promise.all([run("start"), run("start"), run("start")]);
        assert.match((await run("status")).stdout, /Daemon: 0\.1\.0/);
        await run("restart");
        await assert.rejects(run("update", "--archive", join(morty, "missing.tgz")));
        assert.match((await run("status")).stdout, /Daemon: 0\.1\.0/);
        await run("stop");
        assert.match((await run("status")).stdout, /Daemon: not running/);
        await writeFile(join(morty, "user-data"), "keep this file");
        await run("uninstall");
        assert.match((await run("status")).stdout, /Installed: not installed/);
        await access(join(morty, "user-data"));
        assert.deepEqual(await readdir(existing), ["owned-by-moxt"]);
    } finally {
        await run("stop").catch(() => undefined);
        await rm(morty, { recursive: true, force: true });
        await rm(existing, { recursive: true, force: true });
    }
});

test("Given a running Morty installation, When an update process is interrupted during preparation, Then the selected daemon survives and a subsequent update recovers", async () => {
    const archive = process.env.MORTY_RELEASE_ARCHIVE;
    assert.ok(archive, "MORTY_RELEASE_ARCHIVE is required");
    const root = await mkdtemp(join(tmpdir(), "morty-interrupted-update-"));
    const env = { ...process.env, MORTY_STATE_DIRECTORY: root };
    const run = (...args) => execute(process.execPath, [entry, ...args], { env, timeout: 180_000 });
    const cancellation = new AbortController();
    let updater;
    try {
        await run("install", "--archive", archive);
        await run("start");
        const directory = join(root, "executables");
        const events = watch(directory, {
            signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(30_000)]),
        });
        const interrupted = (async () => {
            for await (const event of events) {
                if (event.filename !== "operation.json") {
                    continue;
                }
                const operation = JSON.parse(await readFile(join(directory, "operation.json"), "utf8"));
                if (operation.kind === "preparing") {
                    assert.ok(updater);
                    updater.kill("SIGKILL");
                    return;
                }
            }
            throw new Error("The update never exposed its preparation state");
        })();
        updater = spawn(process.execPath, [entry, "update", "--archive", archive], { env, stdio: "ignore" });
        const exited = new Promise((resolve, reject) => {
            updater.once("exit", (code, signal) => resolve({ code, signal }));
            updater.once("error", reject);
        });
        await interrupted;
        const outcome = await exited;
        assert.ok(outcome.signal !== null || outcome.code !== 0);
        cancellation.abort();
        assert.match((await run("status")).stdout, /Daemon: 0\.1\.0/);
        assert.match((await run("doctor")).stdout, /preparing/);
        await run("update", "--archive", archive);
        assert.match((await run("doctor")).stdout, /complete/);
        assert.match((await run("status")).stdout, /Daemon: 0\.1\.0/);
    } finally {
        cancellation.abort();
        updater?.kill();
        await run("stop").catch(() => undefined);
        await rm(root, { recursive: true, force: true });
    }
});
