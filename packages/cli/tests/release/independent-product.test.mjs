import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
const releaseVersion = JSON.parse(await readFile(join(dirname(entry), "../package.json"), "utf8")).version;

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

test("Given a packed Morty release, version-selected installation and daemon lifecycle preserve adjacent Moxt data and a failed update preserves the installed release", async () => {
    const archive = process.env.MORTY_RELEASE_ARCHIVE;
    assert.ok(archive, "MORTY_RELEASE_ARCHIVE is required");
    const existing = await mkdtemp(join(tmpdir(), "moxt-lifecycle-"));
    const morty = await mkdtemp(join(tmpdir(), "morty-lifecycle-"));
    const env = { ...process.env, MORTY_STATE_DIRECTORY: morty, MOBIUS_STATE_DIRECTORY: existing };
    const run = (...args) => execute(process.execPath, [entry, ...args], { env, timeout: 180_000 });
    try {
        await writeFile(join(existing, "owned-by-moxt"), "preserve this installation\n");
        await run("install", "--version", releaseVersion, "--archive", archive);
        await Promise.all([run("start"), run("start"), run("start")]);
        assert.ok((await run("status")).stdout.includes(`Daemon: ${releaseVersion}\n`));
        const control = join(morty, "installations", "build.morty.cli");
        const pointer = JSON.parse(await readFile(join(control, "current.json"), "utf8"));
        const installation = join(control, pointer.installationId);
        const hash = createHash("sha256").update(installation).digest("hex").slice(0, 32);
        const endpoint =
            process.platform === "win32"
                ? `\\\\.\\pipe\\morty-${hash}`
                : join(tmpdir(), `morty-${process.getuid()}`, `${hash}.sock`);
        const probe = createConnection(endpoint);
        await once(probe, "connect");
        const closed = once(probe, "close");
        probe.destroy();
        await closed;
        assert.ok((await run("status")).stdout.includes(`Daemon: ${releaseVersion}\n`));
        const unauthorized = createConnection(endpoint);
        try {
            await once(unauthorized, "connect");
            const reply = once(unauthorized, "data");
            unauthorized.write(`${JSON.stringify({ kind: "stop", token: "not-a-morty-control-token" })}\n`);
            const [response] = await reply;
            assert.equal(JSON.parse(response.toString()).code, "unauthorized");
        } finally {
            unauthorized.destroy();
        }
        assert.ok((await run("status")).stdout.includes(`Daemon: ${releaseVersion}\n`));
        await run("restart");
        await assert.rejects(run("update", "--version", releaseVersion, "--archive", join(morty, "missing.tgz")));
        assert.ok((await run("status")).stdout.includes(`Daemon: ${releaseVersion}\n`));
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
    let updater;
    try {
        await run("install", "--archive", archive);
        await run("start");
        updater = spawn(process.execPath, [entry, "update", "--archive", archive], {
            env,
            stdio: ["ignore", "pipe", "inherit"],
            timeout: 60_000,
        });
        const exited = new Promise((resolve, reject) => {
            updater.once("exit", (code, signal) => resolve({ code, signal }));
            updater.once("error", reject);
        });
        const interrupted = (async () => {
            let output = "";
            for await (const chunk of updater.stdout) {
                output += chunk.toString();
                if (output.includes("Preparing Morty release;")) {
                    updater.kill("SIGKILL");
                    return;
                }
            }
            throw new Error("The update never exposed its preparation state");
        })();
        await interrupted;
        const outcome = await exited;
        assert.ok(outcome.signal !== null || outcome.code !== 0);
        assert.ok((await run("status")).stdout.includes(`Daemon: ${releaseVersion}\n`));
        assert.match((await run("doctor")).stdout, /preparing/);
        await run("update", "--archive", archive);
        assert.match((await run("doctor")).stdout, /complete/);
        assert.ok((await run("status")).stdout.includes(`Daemon: ${releaseVersion}\n`));
    } finally {
        updater?.kill();
        await run("stop").catch(() => undefined);
        await rm(root, { recursive: true, force: true });
    }
});
