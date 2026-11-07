import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
async function findEntry(scope, name) {
    for (const bin of (process.env.PATH ?? "").split(delimiter)) {
        const candidate = join(bin, "..", scope, name, "dist", "cli.js");
        try {
            await access(candidate);
            return await realpath(candidate);
        } catch {
            /* npm bin directories only. */
        }
    }
    throw new Error(`The actual released ${scope}/${name} package must be on PATH`);
}
const mortyEntry = process.env.MORTY_RELEASE_ENTRY ?? (await findEntry("@morty-build", "cli"));
const moxtEntry = process.env.MOXT_RELEASE_ENTRY ?? (await findEntry("@moxt-ai", "mobius"));
const archive = process.env.MORTY_RELEASE_ARCHIVE;
assert.ok(archive, "MORTY_RELEASE_ARCHIVE is required");

test("Given released Moxt and packed Morty on one machine, each product's lifecycle preserves the other's running service and user data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-moxt-coexistence-"));
    const mortyRoot = join(directory, "morty");
    const moxtRoot = join(directory, "moxt");
    const env = { ...process.env, MORTY_STATE_DIRECTORY: mortyRoot, MOBIUS_STATE_DIRECTORY: moxtRoot };
    const run = (entry, args) => execute(process.execPath, [entry, ...args], { env, timeout: 180_000 });
    const morty = (...args) => run(mortyEntry, args);
    const moxt = (...args) => run(moxtEntry, args);
    try {
        await moxt("start");
        await writeFile(join(moxtRoot, "user-data"), "Moxt keeps this");
        await morty("install", "--archive", archive);
        await morty("start");
        await writeFile(join(mortyRoot, "user-data"), "Morty keeps this");
        for (const args of [["restart"], ["update", "--archive", archive], ["stop"], ["start"], ["uninstall"]]) {
            await morty(...args);
            assert.match((await moxt("status")).stdout, /Daemon: 0\.0\.431/);
            assert.equal(await readFile(join(moxtRoot, "user-data"), "utf8"), "Moxt keeps this");
        }
        await morty("install", "--archive", archive);
        await morty("start");
        for (const args of [["restart"], ["upgrade"], ["stop"], ["start"]]) {
            await moxt(...args);
            assert.match((await morty("status")).stdout, /Daemon: 0\.1\.0/);
            assert.equal(await readFile(join(mortyRoot, "user-data"), "utf8"), "Morty keeps this");
        }
    } finally {
        await Promise.allSettled([morty("stop"), moxt("stop")]);
        await rm(directory, { recursive: true, force: true });
    }
});
