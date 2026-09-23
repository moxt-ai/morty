const { execFileSync } = require("node:child_process");
const { appendFileSync, readFileSync } = require("node:fs");

const previousRevision = process.env.PREVIOUS_MOBIUS_SHA;
const output = process.env.GITHUB_OUTPUT;
if (previousRevision === undefined || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(previousRevision) || output === undefined) {
    throw new Error("Required GitHub Actions inputs are unavailable");
}

const parseVersion = (text, source) => {
    const manifest = JSON.parse(text);
    if (
        typeof manifest !== "object" ||
        manifest === null ||
        Array.isArray(manifest) ||
        typeof manifest.version !== "string"
    ) {
        throw new Error(`Package manifest at ${source} has no string version`);
    }
    return manifest.version;
};

const previousManifest = execFileSync(
    "git",
    ["-C", "third-party/mobius", "show", `${previousRevision}:packages/cli/package.json`],
    { encoding: "utf8", timeout: 30_000 },
);
const previousVersion = parseVersion(previousManifest, "the previous Mobius revision");
const currentVersion = parseVersion(
    readFileSync("third-party/mobius/packages/cli/package.json", "utf8"),
    "third-party/mobius/packages/cli/package.json",
);
const changed = previousVersion !== currentVersion;

console.log(
    changed
        ? `CLI version changed from ${JSON.stringify(previousVersion)} to ${JSON.stringify(currentVersion)}.`
        : `CLI version remains ${JSON.stringify(currentVersion)}; publication will be skipped.`,
);
appendFileSync(output, `changed=${String(changed)}\n`);
