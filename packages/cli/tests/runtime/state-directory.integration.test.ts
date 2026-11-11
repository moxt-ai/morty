import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const entry = resolve(import.meta.dirname, "../../dist/cli.js");

it.each(["empty", "existing"] as const)(
    "Given an %s private state directory, When the user lists pairings, Then Morty works without an installation marker and preserves unrelated files",
    async (kind) => {
        const root = await mkdtemp(join(tmpdir(), "morty-markerless-state-"));
        try {
            const unrelated = join(root, "notes.txt");
            if (kind === "existing") {
                await writeFile(unrelated, "keep this file");
            }
            await execute(process.execPath, [entry, "pair", "list"], {
                env: { ...process.env, MORTY_STATE_DIRECTORY: root },
                timeout: 10_000,
            });
            expect(await readdir(root)).not.toContain("morty-installation.json");
            if (kind === "existing") {
                expect(await readFile(unrelated, "utf8")).toBe("keep this file");
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

it("Given an existing setup root, When machine is mistakenly selected as the state root, Then the CLI reports the owning root without creating nested state", async () => {
    const root = await mkdtemp(join(tmpdir(), "morty-nested-state-"));
    const machine = join(root, "machine");
    try {
        await mkdir(machine);
        await writeFile(join(root, "config.json"), "{}");
        await expect(
            execute(process.execPath, [entry, "pair", "list"], {
                env: { ...process.env, MORTY_STATE_DIRECTORY: machine },
                timeout: 10_000,
            }),
        ).rejects.toMatchObject({ code: 78 });
        expect(await readdir(machine)).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
