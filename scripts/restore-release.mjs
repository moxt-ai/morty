import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { verifiedRelease } from "./release-artifact.mjs";

const run = process.env.GITHUB_RUN_ID;
if (!/^\d+$/.test(run ?? "")) {
    throw new Error("A workflow run is required");
}
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", timeout: 120000 });
const result = JSON.parse(
    gh("api", `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${run}/artifacts?per_page=100`),
);
const archives = result.artifacts.filter((artifact) => artifact.name === "morty-release");
if (archives.length > 1 || archives.some((artifact) => artifact.expired)) {
    throw new Error("Release archive is ambiguous or expired; never rebuild a published release");
}
const restored = archives.length === 1;
if (restored) {
    gh("run", "download", run, "--name", "morty-release", "--dir", ".release");
    await verifiedRelease();
}
await appendFile(process.env.GITHUB_OUTPUT, `restored=${restored}\n`);
