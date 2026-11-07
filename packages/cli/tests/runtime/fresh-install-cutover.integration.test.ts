import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it("Given an old Mobius installation, When Morty is directed to its state, Then adoption is refused and pairing credentials and Agent history remain unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "morty-refuse-legacy-"));
    try {
        const installation = join(root, "versions", "0.0.431", "installations", "dev.mobius.cli", "old-installation");
        await mkdir(installation, { recursive: true });
        await writeFile(join(root, "current-data.txt"), "versions/0.0.431\n");
        await writeFile(join(installation, "credentials.json"), '{"token":"old-product-credential"}');
        await writeFile(join(installation, "agent-history.jsonl"), '{"message":"keep my history"}\n');
        const before = await readdir(root);
        for (const command of [["pair", "list"], ["start"], ["stop"], ["install"]]) {
            await expect(
                execute(process.execPath, [resolve(import.meta.dirname, "../../dist/cli.js"), ...command], {
                    env: { ...process.env, MORTY_STATE_DIRECTORY: root },
                    timeout: 10_000,
                }),
            ).rejects.toMatchObject({ code: 1 });
        }
        expect(await readdir(root)).toEqual(before);
        expect(await readFile(join(installation, "credentials.json"), "utf8")).toBe(
            '{"token":"old-product-credential"}',
        );
        expect(await readFile(join(installation, "agent-history.jsonl"), "utf8")).toBe(
            '{"message":"keep my history"}\n',
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
