import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
export async function verifiedRelease() {
    const manifest = JSON.parse(await readFile(".release/release.json", "utf8"));
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (
        manifest.name !== "@morty-build/cli" ||
        !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
        manifest.archive !== `morty-build-cli-${manifest.version}.tgz` ||
        manifest.revision !== revision
    ) {
        throw new Error("Release identity or source mismatch");
    }
    const archive = resolve(".release", manifest.archive);
    const bytes = await readFile(archive);
    if (
        manifest.sha256 !== createHash("sha256").update(bytes).digest("hex") ||
        manifest.integrity !== `sha512-${createHash("sha512").update(bytes).digest("base64")}`
    ) {
        throw new Error("Release checksum mismatch");
    }
    return { ...manifest, archive };
}
