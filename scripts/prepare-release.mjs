import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";

const baseline = JSON.parse(await readFile("scripts/release-baseline.json", "utf8"));
const metadata = JSON.parse(await readFile("packages/cli/package.json", "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(baseline.version) || !/^[a-f0-9]{40}$/.test(baseline.revision)) {
    throw new Error("Invalid release baseline");
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8", timeout: 30000 }).trim();
let version = metadata.version;
if (process.env.GITHUB_REF === "refs/heads/main") {
    const history = git("rev-list", "--first-parent", "HEAD").split("\n");
    const distance = history.indexOf(baseline.revision);
    if (distance < 1) {
        throw new Error("Release must descend from the baseline on main's first-parent history");
    }
    const [major, minor, patch] = baseline.version.split(".").map(Number);
    if (!Number.isSafeInteger(patch + distance)) {
        throw new Error("Release version exceeds the safe range");
    }
    version = `${major}.${minor}.${patch + distance}`;
}
if (process.env.GITHUB_REF === "refs/heads/main") {
    const response = await fetch(`https://registry.npmjs.org/@morty-build%2fcli/${version}`, {
        signal: AbortSignal.timeout(30_000),
        headers: { "cache-control": "no-cache" },
    });
    await response.body?.cancel();
    if (response.status !== 404) {
        throw new Error(
            "Version exists or registry cannot confirm availability; resume the original immutable archive",
        );
    }
}
metadata.version = version;
await writeFile("packages/cli/package.json", `${JSON.stringify(metadata, null, 4)}\n`);
if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
console.log(`Prepared @morty-build/cli@${version} from ${git("rev-parse", "HEAD")}`);
