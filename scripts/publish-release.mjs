import { execFileSync } from "node:child_process";
import { verifiedRelease } from "./release-artifact.mjs";

const release = await verifiedRelease();
if (
    process.env.GITHUB_REPOSITORY !== "moxt-ai/mobius-morty" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL
) {
    throw new Error("Publishing requires the Morty main-branch OIDC job");
}
// npm cannot generate public provenance for a private source repository.
// OIDC still binds publisher authority; release.json records the tested archive and revision.
const provenance = process.env.GITHUB_REPOSITORY_VISIBILITY === "public";
execFileSync("npm", ["publish", release.archive, "--access", "public", `--provenance=${provenance}`], {
    stdio: "inherit",
    timeout: 180000,
});
const integrity = execFileSync("npm", ["view", `${release.name}@${release.version}`, "dist.integrity"], {
    encoding: "utf8",
    timeout: 60000,
}).trim();
if (integrity !== release.integrity) {
    throw new Error("Registry integrity differs from the tested archive");
}
console.log(`Verified ${release.name}@${release.version} from ${release.revision}`);
