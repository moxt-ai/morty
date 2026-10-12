const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { delimiter, join } = require("node:path");
const { test } = require("node:test");

const repositoryRoot = join(__dirname, "..");
const publisher = join(repositoryRoot, "scripts", "publish-web-assets.sh");

const runPublisher = (workingDirectory, environment) =>
    new Promise((resolve, reject) => {
        const child = spawn("bash", [publisher, "staging"], {
            cwd: workingDirectory,
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let standardError = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            standardError += chunk;
        });
        child.once("error", reject);
        child.once("exit", (status) => resolve({ standardError, status }));
    });

test("Given built JavaScript, CSS, and KaTeX fonts, publishing uploads every supported asset", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "morty-web-assets-"));
    try {
        const assetsDirectory = join(workingDirectory, "dist", "client", "assets");
        const binaryDirectory = join(workingDirectory, "bin");
        const callsFile = join(workingDirectory, "calls.jsonl");
        await mkdir(assetsDirectory, { recursive: true });
        await mkdir(binaryDirectory);
        await Promise.all([
            writeFile(join(assetsDirectory, "app-abc.js"), "export {};"),
            writeFile(join(assetsDirectory, "app-abc.css"), ".math {}"),
            writeFile(join(assetsDirectory, "KaTeX_Main-Regular-abc.ttf"), "font"),
            writeFile(join(assetsDirectory, "KaTeX_Main-Regular-abc.woff"), "font"),
            writeFile(join(assetsDirectory, "KaTeX_Main-Regular-abc.woff2"), "font"),
            writeFile(
                join(binaryDirectory, "pnpm"),
                `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("info")) {
    process.stdout.write("{}\\n");
    process.exit(0);
}
const manifestIndex = args.indexOf("--filename");
const contentTypeIndex = args.indexOf("--content-type");
fs.appendFileSync(
    process.env.TEST_CALLS,
    JSON.stringify({
        contentType: args[contentTypeIndex + 1],
        manifest: JSON.parse(fs.readFileSync(args[manifestIndex + 1], "utf8")),
    }) + "\\n",
);
`,
                { mode: 0o755 },
            ),
            writeFile(
                join(binaryDirectory, "curl"),
                `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const headerIndex = args.indexOf("--dump-header");
fs.writeFileSync(
    args[headerIndex + 1],
    "access-control-allow-origin: https://morty.paradev.biz\\ncache-control: public, max-age=31536000, immutable\\n",
);
`,
                { mode: 0o755 },
            ),
        ]);

        const result = await runPublisher(workingDirectory, {
            ...process.env,
            PATH: `${binaryDirectory}${delimiter}${process.env.PATH}`,
            TEST_CALLS: callsFile,
        });

        assert.equal(result.status, 0, result.standardError);
        const calls = (await readFile(callsFile, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        assert.deepEqual(
            calls.map(({ contentType }) => contentType),
            ["text/javascript; charset=utf-8", "text/css; charset=utf-8", "font/ttf", "font/woff", "font/woff2"],
        );
        assert.deepEqual(
            calls.flatMap(({ manifest }) => manifest.map(({ key }) => key)),
            [
                "assets/app-abc.js",
                "assets/app-abc.css",
                "assets/KaTeX_Main-Regular-abc.ttf",
                "assets/KaTeX_Main-Regular-abc.woff",
                "assets/KaTeX_Main-Regular-abc.woff2",
            ],
        );
    } finally {
        await rm(workingDirectory, { recursive: true, force: true });
    }
});
