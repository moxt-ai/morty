import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { verifiedRelease } from "./release-artifact.mjs";

const release = await verifiedRelease();
const cloud = JSON.parse(await readFile(".release/cloud/release.json", "utf8"));
if (
    cloud.revision !== release.revision ||
    cloud.cliVersion !== release.version ||
    cloud.cliRelease?.integrity !== release.integrity
) {
    throw new Error("Cloud and CLI release identities differ");
}
const evidenceDirectories = (await readdir(".release/evidence")).sort(
    (a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)),
);
let evidence;
for (const directory of evidenceDirectories) {
    const files = await readdir(join(".release/evidence", directory));
    if (files.includes("deployment-evidence.json")) {
        evidence = JSON.parse(await readFile(join(".release/evidence", directory, "deployment-evidence.json"), "utf8"));
        break;
    }
}
if (
    !evidence?.passed ||
    evidence.revision !== release.revision ||
    evidence.cliVersion !== release.version ||
    evidence.cliIntegrity !== release.integrity
) {
    throw new Error("No successful deployment evidence for this exact release");
}
const currentSetup = await fetch(new URL("/setup.mjs", cloud.target.morty_origin), {
    signal: AbortSignal.timeout(40_000),
    headers: { "cache-control": "no-cache" },
});
if (
    !currentSetup.ok ||
    createHash("sha256")
        .update(Buffer.from(await currentSetup.arrayBuffer()))
        .digest("hex") !== cloud.files["setup.mjs"]
) {
    throw new Error("Production no longer serves this release's setup artifact");
}
const currentNpm = await fetch("https://registry.npmjs.org/@morty-build%2fcli/latest", {
    signal: AbortSignal.timeout(30_000),
});
if (!currentNpm.ok) {
    await currentNpm.body?.cancel();
    throw new Error("Cannot verify the current npm release");
}
const published = await currentNpm.json();
if (published.version !== release.version || published.dist?.integrity !== release.integrity) {
    throw new Error("Refusing to finalize a superseded or mismatched release");
}
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", timeout: 120000 });
const repository = process.env.GITHUB_REPOSITORY;
if (repository !== "moxt-ai/mobius-morty" || process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Release finalization requires the protected main workflow");
}
const tag = `v${release.version}`;
const refs = JSON.parse(gh("api", `repos/${repository}/git/matching-refs/tags/${tag}`));
const existingTag = refs.find((ref) => ref.ref === `refs/tags/${tag}`);
if (existingTag && (existingTag.object.type !== "commit" || existingTag.object.sha !== release.revision)) {
    throw new Error("The release tag already identifies different source");
}
// The exact tag is known; list pagination avoids interpreting API failures as absence.
const pages = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`));
const existing = pages.flat().find((item) => item.tag_name === tag);
if (existing && !existingTag) {
    if (existing.target_commitish !== release.revision) {
        throw new Error("Draft release source mismatch");
    }
}
await mkdir(".release/assets", { recursive: true });
await copyFile(release.archive, join(".release/assets", basename(release.archive)));
await copyFile(".release/release.json", ".release/assets/cli-release.json");
await copyFile(".release/cloud/release.json", ".release/assets/cloud-release.json");
await writeFile(".release/assets/deployment-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
// Canonical metadata makes retries produce the same archived cloud bytes.
execFileSync(
    "tar",
    [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--format=gnu",
        "-czf",
        ".release/assets/cloud.tar.gz",
        "-C",
        ".release/cloud",
        ".",
    ],
    { timeout: 120000 },
);
const verifyPublishedAssets = async (publishedRelease) => {
    if (!publishedRelease.immutable || publishedRelease.draft) {
        throw new Error("The final release must have repository-enforced immutability");
    }
    for (const name of [basename(release.archive), "cli-release.json", "cloud-release.json", "cloud.tar.gz"]) {
        const digest = `sha256:${createHash("sha256")
            .update(await readFile(join(".release/assets", name)))
            .digest("hex")}`;
        const asset = publishedRelease.assets.find((candidate) => candidate.name === name);
        if (asset?.digest !== digest || asset.state !== "uploaded") {
            throw new Error("Final release assets do not match the accepted artifacts");
        }
    }
};
if (existing && !existing.draft) {
    await verifyPublishedAssets(existing);
    console.log(`Release ${tag} is already finalized at ${release.revision}`);
    process.exit(0);
}
await writeFile(
    ".release/notes.txt",
    `Source: ${release.revision}\n\nCLI: @morty-build/cli@${release.version}\nSHA-256: ${release.sha256}\n\nPublished with npm trusted publishing, verified against the accepted archive, and deployed to production before finalizing this release.\n\nAcceptance and deployment: https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}\n`,
);
if (!existing) {
    gh(
        "release",
        "create",
        tag,
        "--draft",
        "--target",
        release.revision,
        "--title",
        tag,
        "--notes-file",
        ".release/notes.txt",
    );
}
// Only this workflow's still-private draft may receive resumed asset uploads.
const assets = (await readdir(".release/assets")).map((name) => join(".release/assets", name));
gh("release", "upload", tag, ...assets, "--clobber");
gh("release", "edit", tag, "--draft=false", "--latest");
await verifyPublishedAssets(JSON.parse(gh("api", `repos/${repository}/releases/tags/${tag}`)));
console.log(`Finalized ${tag} from ${release.revision}`);
