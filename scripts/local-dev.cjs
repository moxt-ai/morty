#!/usr/bin/env node
"use strict";

// Local full-stack development helper for Morty.
//
// Dependency-free CommonJS. Requires the repository's pinned Node.js (>= 24).
//
//   node scripts/local-dev.cjs prepare [options]
//   node scripts/local-dev.cjs setup  --state-dir <dir> --harness <id> --session-id <id> [options]
//   node scripts/local-dev.cjs status  --state-dir <dir>
//   node scripts/local-dev.cjs logs    --state-dir <dir> [options]
//   node scripts/local-dev.cjs remove  --state-dir <dir> [options]
//
// `prepare` starts an isolated Chat Worker plus the local Platform fixture it
// authenticates against, then prints a single JSON descriptor on stdout. All
// human-readable progress goes to stderr so stdout stays machine-parseable.

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { pathToFileURL } = require("node:url");
const hostPlatform = require("./platform/index.cjs");

const REPO_ROOT = path.resolve(__dirname, "..");
const WRANGLER = path.join(REPO_ROOT, "node_modules", ".bin", "wrangler");
const PLATFORM_CONFIG = "packages/e2e/fixtures/wrangler.platform.jsonc";
const CHAT_CONFIG = "packages/e2e/fixtures/wrangler.chat.jsonc";
const MOBIUS_ROOT = path.join(REPO_ROOT, "third-party", "mobius");
const MOBIUS_LOCKFILE = path.join(MOBIUS_ROOT, "pnpm-lock.yaml");
const MOBIUS_INSTALLED_LOCKFILE = path.join(MOBIUS_ROOT, "node_modules", ".pnpm", "lock.yaml");
const SETUP_BUNDLE = "packages/setup/dist/setup.mjs";
const CHAT_ATTACHMENTS_BUCKET = "morty-local-e2e-attachments";
/** An identifier the setup bundle and Platform accept for a harness or native session. */
const HARNESS_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const PLATFORM_AUTH_HEADERS = {
    "content-type": "application/json",
    authorization: "Bearer morty-local-e2e",
    "x-mobius-oidc-provider": "e2e",
};

async function availablePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
                server.close(() => reject(new Error("Could not allocate a local port")));
                return;
            }
            const port = address.port;
            server.close((error) => (error === undefined ? resolve(port) : reject(error)));
        });
    });
}
const DEFAULT_STAGING_PLATFORM = "https://mobius.moxt.ws";

function log(message) {
    process.stderr.write(`[local-dev] ${message}\n`);
}

function fail(message) {
    log(`ERROR ${message}`);
    process.exit(1);
}

function parseArguments(argv) {
    const options = { command: argv[0] ?? "help", mode: argv[1] ?? "web-server" };
    const requireValue = (index, token) => {
        const value = argv[index + 1];
        if (value === undefined || value.length === 0) {
            fail(`${token} requires a value`);
        }
        return value;
    };
    for (let index = 1; index < argv.length; index += 1) {
        const token = argv[index];
        if (index === 1 && !token.startsWith("--")) {
            options.mode = token;
            continue;
        }
        const equals = token.indexOf("=");
        if (equals > 0 && (token.startsWith("--app-id") || token.startsWith("--app-secret"))) {
            const name = token.slice(0, equals);
            const value = token.slice(equals + 1);
            if (value.length === 0) {
                fail(`${name} requires a value`);
            }
            options[name === "--app-id" ? "appId" : "appSecret"] = value;
            continue;
        }
        switch (token) {
            case "--state-dir":
                options.stateDir = path.resolve(requireValue(index, token));
                index += 1;
                break;
            case "--app-id":
                options.appId = requireValue(index, token);
                index += 1;
                break;
            case "--app-secret":
                options.appSecret = requireValue(index, token);
                index += 1;
                break;
            case "--platform-port":
                options.platformPort = Number.parseInt(requireValue(index, token), 10);
                index += 1;
                break;
            case "--chat-port":
                options.chatPort = Number.parseInt(requireValue(index, token), 10);
                index += 1;
                break;
            case "--worker":
                options.worker = requireValue(index, token);
                index += 1;
                break;
            case "--harness":
                options.harness = requireValue(index, token);
                index += 1;
                break;
            case "--session-id":
                options.sessionId = requireValue(index, token);
                index += 1;
                break;
            case "--workspace":
                options.workspace = requireValue(index, token);
                index += 1;
                break;
            case "--lines":
                options.lines = Number.parseInt(requireValue(index, token), 10);
                index += 1;
                break;
            case "--filter":
                options.filter = requireValue(index, token);
                index += 1;
                break;
            case "--follow":
                options.follow = true;
                break;
            case "--force":
                options.force = true;
                break;
            case "--no-build":
                options.build = false;
                break;
            case "--keep-state":
                options.keepState = true;
                break;
            case "--background":
                options.background = true;
                break;
            default:
                break;
        }
    }
    return options;
}

async function localLaunch(command, args) {
    const { executableLaunch, findExecutableOnPath, resolveExecutablePath } = await import(
        pathToFileURL(path.join(MOBIUS_ROOT, "packages/cli/src/util/process/executable.ts")).href
    );
    const executable = path.isAbsolute(command)
        ? await resolveExecutablePath(command)
        : await findExecutableOnPath(command, process.env);
    if (executable === null) {
        throw new Error(`A supported executable is required: ${command}`);
    }
    return executableLaunch(executable.path, args);
}

async function run(command, args, options = {}) {
    const launch = await localLaunch(command, args);
    return new Promise((resolve, reject) => {
        const child = spawn(launch.command, launch.arguments, {
            cwd: options.cwd ?? REPO_ROOT,
            env: { ...process.env, ...options.env },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            signal: options.signal,
            timeout: options.timeout,
            killSignal: "SIGKILL",
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) =>
            code === 0
                ? resolve({ stdout, stderr })
                : reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${(stderr || stdout).slice(-2_000)}`)),
        );
    });
}

function wrangler(args) {
    return run(WRANGLER, args);
}

async function startProcess(name, args, logPath, command = WRANGLER, env = {}, cwd = REPO_ROOT) {
    const launch = await localLaunch(command, args);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const output = fs.openSync(logPath, "a", 0o600);
    const child = spawn(launch.command, launch.arguments, {
        cwd,
        env: { ...process.env, ...env },
        detached: true,
        windowsHide: true,
        stdio: ["ignore", output, output],
    });
    child.unref();
    fs.closeSync(output);
    if (child.pid === undefined) {
        throw new Error(`Could not start ${name}`);
    }
    log(`started ${name} pid=${child.pid}`);
    return child.pid;
}

function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function stopProcess(pid) {
    await hostPlatform.stopProcess(pid);
}

async function waitForHttp(url, accept, timeoutMilliseconds, description, process) {
    const deadline = Date.now() + timeoutMilliseconds;
    let last = "no attempt";
    while (Date.now() < deadline) {
        if (process !== undefined && !isAlive(process.pid)) {
            throw new Error(`${description} process exited before becoming healthy; see ${process.logPath}`);
        }
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
            if (await accept(response)) {
                return;
            }
            last = `status ${response.status}`;
        } catch (error) {
            last = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`Timed out waiting for ${description}: ${last}`);
}

async function ensureMobiusDependencies() {
    const installed =
        fs.existsSync(MOBIUS_INSTALLED_LOCKFILE) &&
        fs.readFileSync(MOBIUS_LOCKFILE).equals(fs.readFileSync(MOBIUS_INSTALLED_LOCKFILE));
    if (installed) {
        return;
    }
    log("installing Mobius submodule dependencies from the lockfile");
    await run("pnpm", ["install", "--frozen-lockfile"], { cwd: MOBIUS_ROOT });
}

async function httpJson(url, options = {}) {
    const response = await fetch(url, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers: options.headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMilliseconds ?? 20_000),
    });
    const text = await response.text();
    let value = {};
    try {
        value = text.length === 0 ? {} : JSON.parse(text);
    } catch {
        throw new Error(`${url} returned non-JSON (${response.status}): ${text.slice(0, 300)}`);
    }
    if (!response.ok) {
        throw new Error(`${url} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return value;
}

function readStack(stateDir) {
    const file = path.join(stateDir, "stack.json");
    if (!fs.existsSync(file)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeStack(stack) {
    fs.writeFileSync(path.join(stack.stateDir, "stack.json"), `${JSON.stringify(stack, null, 2)}\n`, {
        mode: 0o600,
    });
}

async function prepareWeb(options) {
    const chatPort = options.chatPort ?? (await availablePort());
    const stateDir = options.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "chat-local-web-dev-"));
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const chatOrigin = `http://localhost:${chatPort}`;
    const logPath = path.join(stateDir, "web.log");
    const appId = options.appId;
    const appSecret = options.appSecret;
    if (appId === undefined || appId.length === 0 || appSecret === undefined || appSecret.length === 0) {
        throw new Error("web mode requires --app-id and --app-secret");
    }
    const pid = await startProcess(
        "web",
        ["exec", "vite", "--host", "localhost", "--port", String(chatPort)],
        logPath,
        "pnpm",
        {
            VITE_MOBIUS_BASE_URL: process.env.MORTY_LOCAL_PLATFORM_URL ?? DEFAULT_STAGING_PLATFORM,
            VITE_MOBIUS_APP_ID: appId,
        },
    );
    await waitForHttp(chatOrigin, (response) => response.ok, 90_000, "local web app");
    const stack = { mode: options.mode, appId, chatOrigin, chatLog: logPath, chatPid: pid, stateDir, ready: true };
    writeStack(stack);
    process.stdout.write(`${JSON.stringify(stack)}\n`);
    await keepAlive(stack, options);
}

async function keepAlive(stack, options) {
    if (options.background === true) {
        return;
    }
    await new Promise((resolve) => {
        const shutdown = async () => {
            await stopRecorded(stack);
            resolve();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
    });
}

async function prepare(options) {
    const validModes = new Set(["web", "web-server", "web-server-mobius", "web-server-mobius-cli"]);
    if (!validModes.has(options.mode)) {
        throw new Error(
            `Unknown mode ${options.mode}; use web, web-server, web-server-mobius, or web-server-mobius-cli`,
        );
    }
    if (options.mode === "web") {
        return prepareWeb(options);
    }
    const platformPort = options.platformPort ?? (await availablePort());
    const chatPort = options.chatPort ?? (await availablePort());
    const stateDir = options.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "chat-local-full-dev-"));
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    const existing = readStack(stateDir);
    if (existing !== null) {
        if (options.force !== true && isAlive(existing.chatPid) && isAlive(existing.platformPid)) {
            log(`reusing live stack at ${stateDir}`);
            process.stdout.write(`${JSON.stringify(existing)}\n`);
            return;
        }
        log(`stopping existing stack at ${stateDir}`);
        await stopRecorded(existing);
    }

    const platformPersist = path.join(stateDir, "platform");
    const chatPersist = path.join(stateDir, "chat");
    const chatLog = path.join(stateDir, "chat.log");
    const platformLog = path.join(stateDir, "platform.log");
    const chatOrigin = `http://localhost:${chatPort}`;
    const platformOrigin = `http://127.0.0.1:${platformPort}`;
    const sessionWebhookSecretEncryptionKey = crypto.randomBytes(32).toString("base64");
    let stack = {
        mode: options.mode,
        chatLog,
        chatOrigin,
        chatPersist,
        platformConfig: PLATFORM_CONFIG,
        platformLog,
        platformOrigin,
        platformPersist,
        ready: false,
        stateDir,
    };
    writeStack(stack);

    try {
        await ensureMobiusDependencies();
        log("applying Platform migrations");
        await wrangler([
            "d1",
            "migrations",
            "apply",
            "PLATFORM_DIRECTORY_DATABASE",
            "--local",
            "--persist-to",
            platformPersist,
            "--config",
            PLATFORM_CONFIG,
        ]);

        log("starting Platform fixture");
        const platformPid = await startProcess(
            "platform",
            [
                "dev",
                "--config",
                PLATFORM_CONFIG,
                "--ip",
                "127.0.0.1",
                "--port",
                String(platformPort),
                "--inspector-port",
                "0",
                "--persist-to",
                platformPersist,
                "--var",
                `MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY:${sessionWebhookSecretEncryptionKey}`,
            ],
            platformLog,
        );
        stack = { ...stack, platformPid };
        writeStack(stack);
        await waitForHttp(
            `${platformOrigin}/mobius/api/dashboard/health`,
            (response) => response.ok,
            90_000,
            "Platform health",
            { pid: platformPid, logPath: platformLog },
        );

        let appId = options.appId;
        let appSecret = options.appSecret;
        if (appId === undefined || appId.length === 0 || appSecret === undefined || appSecret.length === 0) {
            log("provisioning local Platform application");
            const inventory = await httpJson(`${platformOrigin}/mobius/api/dashboard/v1/platform/tenants`, {
                headers: PLATFORM_AUTH_HEADERS,
            });
            const tenantId = inventory.tenants?.[0]?.tenantId;
            if (typeof tenantId !== "string") {
                throw new Error("The local Platform did not return a tenant");
            }
            const application = await httpJson(`${platformOrigin}/mobius/api/dashboard/v1/apps`, {
                headers: PLATFORM_AUTH_HEADERS,
                body: {
                    displayName: `Morty local dev ${path.basename(stateDir)}`,
                    tenantId,
                },
            });
            appId = application.appId;
            appSecret = application.defaultCredential?.credential;
        }
        if (
            typeof appId !== "string" ||
            appId.length === 0 ||
            typeof appSecret !== "string" ||
            appSecret.length === 0
        ) {
            throw new Error("Set --app-id and --app-secret, or allow local app provisioning");
        }

        if (options.build !== false) {
            log("building Chat Worker and setup bundle");
            await run("pnpm", ["build"]);
        }
        if (!fs.existsSync(path.join(REPO_ROOT, SETUP_BUNDLE))) {
            throw new Error(`Missing setup bundle at ${SETUP_BUNDLE}; run without --no-build`);
        }

        log("seeding setup bundle into local R2");
        await wrangler([
            "r2",
            "object",
            "put",
            `${CHAT_ATTACHMENTS_BUCKET}/artifacts/setup.mjs`,
            "--file",
            SETUP_BUNDLE,
            "--local",
            "--persist-to",
            chatPersist,
            "--config",
            CHAT_CONFIG,
        ]);

        const variables = {
            APP_ORIGIN: chatOrigin,
            AUTHENTICATION_BASE_URL: chatOrigin,
            MOBIUS_APP_ID: appId,
            MOBIUS_APP_SECRET: appSecret,
            MOBIUS_BASE_URL: platformOrigin,
        };
        const variableArguments = Object.entries(variables).flatMap(([key, value]) => ["--var", `${key}:${value}`]);

        log("starting Chat Worker");
        const chatPid = await startProcess(
            "chat",
            [
                "dev",
                "--config",
                CHAT_CONFIG,
                "--ip",
                "127.0.0.1",
                "--port",
                String(chatPort),
                "--inspector-port",
                "0",
                "--persist-to",
                chatPersist,
                ...variableArguments,
            ],
            chatLog,
        );
        stack = { ...stack, appId, chatPid };
        writeStack(stack);
        await waitForHttp(chatOrigin, (response) => response.ok, 90_000, "Chat Worker", {
            pid: chatPid,
            logPath: chatLog,
        });

        let cliLog;
        if (options.mode === "web-server-mobius-cli") {
            cliLog = path.join(stateDir, "cli.log");
            log("checking local Mobius CLI");
            await run("pnpm", ["--dir", "third-party/mobius", "mobius", "agents"], {
                cwd: REPO_ROOT,
                env: { MOBIUS_STATE_DIRECTORY: path.join(stateDir, "mobius") },
            }).then(({ stdout, stderr }) => fs.writeFileSync(cliLog, `${stdout}${stderr}`, { mode: 0o600 }));
        }

        stack = {
            ...stack,
            appId,
            mode: options.mode,
            cliCommand:
                options.mode === "web-server-mobius-cli" ? "pnpm --dir third-party/mobius mobius agents" : undefined,
            ...(cliLog === undefined ? {} : { cliLog }),
            chatConfig: CHAT_CONFIG,
            chatLog,
            chatOrigin,
            chatPersist,
            chatPid,
            platformConfig: PLATFORM_CONFIG,
            platformLog,
            platformOrigin,
            platformPersist,
            platformPid,
            ready: true,
            stateDir,
        };
        writeStack(stack);
        log(`ready at ${chatOrigin}`);
        process.stdout.write(`${JSON.stringify(stack)}\n`);
        await keepAlive(stack, options);
    } catch (error) {
        await stopRecorded(stack);
        writeStack({ ...stack, ready: false });
        throw error;
    }
}

const SETUP_READY_TIMEOUT_MILLISECONDS = 300_000;

async function installLocalCli(stack) {
    const cliDirectory = path.join(MOBIUS_ROOT, "packages/cli");
    const manifest = JSON.parse(fs.readFileSync(path.join(cliDirectory, "package.json"), "utf8"));
    if (
        manifest.name !== "@moxt-ai/mobius" ||
        typeof manifest.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u.test(manifest.version)
    ) {
        fail("the checkout's CLI package must have a valid Mobius name and version");
    }
    const packageDirectory = fs.mkdtempSync(path.join(stack.stateDir, "cli-package-"));
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const options = {
        signal: controller.signal,
        timeout: SETUP_READY_TIMEOUT_MILLISECONDS,
    };
    try {
        log(`building and packing the checkout's Mobius CLI ${manifest.version}`);
        await run("pnpm", ["pack", "--pack-destination", packageDirectory], { ...options, cwd: cliDirectory });
        controller.signal.throwIfAborted();
        const tarball = path.join(packageDirectory, `moxt-ai-mobius-${manifest.version}.tgz`);
        const prefix = path.join(stack.stateDir, "mobius", "npm", manifest.version);
        log(`installing the local CLI into ${prefix}`);
        await run(
            "npm",
            [
                "install",
                "--prefix",
                prefix,
                "--ignore-scripts",
                "--omit=dev",
                "--no-audit",
                "--no-fund",
                "--save-exact",
                "--",
                tarball,
            ],
            options,
        );
        controller.signal.throwIfAborted();
    } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
        fs.rmSync(packageDirectory, { recursive: true, force: true });
    }
}

function readSetupRecord(line) {
    if (line.length === 0) {
        return null;
    }
    try {
        const value = JSON.parse(line);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            return value;
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Runs the Chat-served setup bundle's `setup` flow with Morty's writable
 * location isolated under the stack's state directory. `morty/` isolates
 * Morty's saved setup state, `documents/` stands in for the Documents folder
 * earlier releases kept it in, `mobius/` isolates its CLI manager and connection
 * state, and `workspace/` is the default working directory. On success prints
 * one JSON record whose `handoffUrl` continues the setup identity in the
 * browser.
 */
async function setup(options) {
    if (options.harness === undefined) {
        fail("--harness is required; pass the selected harness identifier, for example codex or claude");
    }
    if (!HARNESS_IDENTIFIER_PATTERN.test(options.harness)) {
        fail("--harness must be a harness identifier");
    }
    const harness = options.harness;
    if (options.sessionId === undefined) {
        fail("--session-id is required; pass the selected harness's exact current session identifier");
    }
    if (!HARNESS_IDENTIFIER_PATTERN.test(options.sessionId)) {
        fail("--session-id must be a harness session identifier");
    }
    const sessionId = options.sessionId;
    const stack = options.stateDir === undefined ? null : readStack(options.stateDir);
    if (stack === null) {
        fail("pass --state-dir for a stack created by prepare");
    }
    if (!isAlive(stack.chatPid)) {
        fail("the stack's Chat Worker is not running; run prepare first");
    }
    const documents = path.join(stack.stateDir, "documents");
    const mortyStateDirectory = path.join(stack.stateDir, "morty");
    const mobiusStateDirectory = path.join(stack.stateDir, "mobius");
    const workspace = path.resolve(options.workspace ?? path.join(stack.stateDir, "workspace"));
    for (const directory of [documents, mortyStateDirectory, mobiusStateDirectory, workspace]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    await installLocalCli(stack);
    const origin = new URL(stack.chatOrigin).origin;

    log(`downloading the setup bundle from ${origin}`);
    const setupBundle = path.join(stack.stateDir, "setup.mjs");
    const setupResponse = await fetch(`${origin}/setup.mjs`, { signal: AbortSignal.timeout(20_000) });
    if (!setupResponse.ok) {
        fail(`downloading setup.mjs failed (${setupResponse.status})`);
    }
    fs.writeFileSync(setupBundle, Buffer.from(await setupResponse.arrayBuffer()), { mode: 0o600 });

    const setupLog = path.join(stack.stateDir, "setup.log");
    fs.writeFileSync(setupLog, "", { mode: 0o600 });
    const shimDirectory = path.join(stack.stateDir, "local-cli-bin");
    fs.mkdirSync(shimDirectory, { recursive: true, mode: 0o700 });
    const shim = path.join(shimDirectory, hostPlatform.cliShimName);
    fs.writeFileSync(
        shim,
        `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [${JSON.stringify(path.join(MOBIUS_ROOT, "packages/cli/src/cli/entrypoint.ts"))}, ...args], {
    stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
        { mode: 0o700 },
    );
    hostPlatform.writeCommandShim(shimDirectory);
    log(`running setup for harness "${harness}" against workspace ${workspace}`);
    const runtimePid = await startProcess(
        "setup runtime",
        [
            setupBundle,
            "setup",
            "--base-url",
            origin,
            "--cwd",
            workspace,
            "--harness",
            harness,
            "--session-id",
            sessionId,
        ],
        setupLog,
        process.execPath,
        {
            DOCUMENT_DIR: documents,
            MORTY_STATE_DIRECTORY: mortyStateDirectory,
            MOBIUS_STATE_DIRECTORY: mobiusStateDirectory,
            PATH: `${shimDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        workspace,
    );

    const deadline = Date.now() + SETUP_READY_TIMEOUT_MILLISECONDS;
    let ready = null;
    let runtimeId = null;
    let reusedConnectionId = null;
    for (;;) {
        const records = fs
            .readFileSync(setupLog, "utf8")
            .split("\n")
            .filter((line) => line.length > 0)
            .map(readSetupRecord);
        const failure = records.findLast((record) => record !== null && record.error !== undefined);
        if (failure !== undefined && failure !== null) {
            await stopProcess(runtimePid);
            fail(`setup failed: ${JSON.stringify(failure.error)}`);
        }
        const reused = records.findLast((record) => record !== null && record.status === "runtime_reused");
        if (reused !== undefined && reused !== null && typeof reused.runtimeId === "string") {
            runtimeId = reused.runtimeId;
            if (typeof reused.connectionId === "string") {
                reusedConnectionId = reused.connectionId;
            }
        }
        const paired = records.findLast((record) => record !== null && record.status === "runtime_paired");
        if (paired !== undefined && paired !== null && typeof paired.runtimeId === "string") {
            runtimeId = paired.runtimeId;
        }
        const completed = records.findLast((record) => record !== null && record.status === "ready");
        if (completed !== undefined && completed !== null) {
            ready = completed;
            break;
        }
        if (Date.now() > deadline || !isAlive(runtimePid)) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (ready === null) {
        await stopProcess(runtimePid);
        fail(
            `the setup runtime did not report ready within ${SETUP_READY_TIMEOUT_MILLISECONDS / 1000}s; see ${setupLog}`,
        );
    }
    if (runtimeId === null) {
        fail("the setup runtime did not report its Runtime ID");
    }
    const handoffUrl = typeof ready.url === "string" ? ready.url : "";
    if (handoffUrl.length === 0) {
        fail("the setup runtime did not return a handoff URL");
    }

    let connectionId = reusedConnectionId;
    if (connectionId === null) {
        const pairList = path.join(stack.stateDir, `.pair-list-${crypto.randomUUID()}.json`);
        fs.writeFileSync(pairList, "", { mode: 0o600, flag: "wx" });
        try {
            await run(
                process.execPath,
                [
                    path.join(MOBIUS_ROOT, "packages/cli/src/cli/entrypoint.ts"),
                    "pair",
                    "list",
                    `--output-json=${pairList}`,
                ],
                { env: { MOBIUS_STATE_DIRECTORY: mobiusStateDirectory } },
            );
            const listed = JSON.parse(fs.readFileSync(pairList, "utf8"));
            if (!Array.isArray(listed)) {
                fail("Mobius returned an invalid connection list");
            }
            const connection = listed.find(
                (item) =>
                    item !== null &&
                    typeof item === "object" &&
                    item.app_id === stack.appId &&
                    item.runtime_id === runtimeId,
            );
            if (
                connection === undefined ||
                typeof connection.connection_id !== "string" ||
                !/^mcn_[a-f0-9]{32}$/u.test(connection.connection_id)
            ) {
                fail("Mobius did not report the setup connection");
            }
            connectionId = connection.connection_id;
        } finally {
            fs.rmSync(pairList, { force: true });
        }
    }

    const record = {
        chatOrigin: stack.chatOrigin,
        connectionId,
        documents,
        handoffUrl,
        mortyStateDirectory,
        harness,
        mobiusStateDirectory,
        runtimePid,
        sessionId,
        setupLog,
        workspace,
    };
    const previous = Array.isArray(stack.runtimes) ? stack.runtimes : [];
    writeStack({ ...stack, runtimes: [...previous, record] });
    process.stdout.write(`${JSON.stringify(record)}\n`);
    log("setup is ready; open handoffUrl in the browser to continue as this user");
}

async function status(options) {
    const stack = options.stateDir === undefined ? null : readStack(options.stateDir);
    if (stack === null) {
        fail("pass --state-dir for a stack created by prepare");
    }
    const chatAlive = isAlive(stack.chatPid);
    const platformAlive = stack.platformPid === undefined ? false : isAlive(stack.platformPid);
    const runtimes = Array.isArray(stack.runtimes)
        ? stack.runtimes.map((runtime) => ({ ...runtime, alive: isAlive(runtime.runtimePid) }))
        : [];
    let chatHttp = false;
    let platformHttp = false;
    try {
        chatHttp = (await fetch(stack.chatOrigin, { signal: AbortSignal.timeout(3_000) })).ok;
    } catch {
        chatHttp = false;
    }
    if (stack.platformOrigin !== undefined) {
        try {
            platformHttp = (
                await fetch(`${stack.platformOrigin}/mobius/api/dashboard/health`, {
                    signal: AbortSignal.timeout(3_000),
                })
            ).ok;
        } catch {
            platformHttp = false;
        }
    }
    process.stdout.write(
        `${JSON.stringify({ ...stack, chatAlive, chatHttp, platformAlive, platformHttp, runtimes }, null, 2)}\n`,
    );
}

function readLines(file, count) {
    if (!fs.existsSync(file)) {
        return [];
    }
    return fs.readFileSync(file, "utf8").split("\n").slice(-count);
}

async function logs(options) {
    const stack = options.stateDir === undefined ? null : readStack(options.stateDir);
    if (stack === null) {
        fail("pass --state-dir for a stack created by prepare");
    }
    const worker = options.worker ?? "chat";
    const runtimeLogs = (Array.isArray(stack.runtimes) ? stack.runtimes : []).map((runtime) => runtime.setupLog);
    const uniqueRuntimeLogs = [...new Set(runtimeLogs.filter((file) => typeof file === "string"))];
    const files =
        worker === "all"
            ? [stack.chatLog, stack.platformLog, ...uniqueRuntimeLogs].filter((file) => file !== undefined)
            : worker === "platform"
              ? stack.platformLog === undefined
                  ? []
                  : [stack.platformLog]
              : worker === "runtime"
                ? uniqueRuntimeLogs
                : [stack.chatLog];
    const filter = options.filter === undefined ? null : new RegExp(options.filter, "u");
    const count = Number.isInteger(options.lines) ? options.lines : 200;
    const print = (file) => {
        for (const line of readLines(file, count)) {
            if (line.length === 0) {
                continue;
            }
            if (filter === null || filter.test(line)) {
                process.stdout.write(`${line}\n`);
            }
        }
    };
    for (const file of files) {
        print(file);
    }
    if (options.follow === true) {
        log(`following ${files.join(", ")}; press Ctrl+C to stop`);
        const offsets = new Map(files.map((file) => [file, fs.existsSync(file) ? fs.statSync(file).size : 0]));
        for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            for (const file of files) {
                if (!fs.existsSync(file)) {
                    continue;
                }
                const size = fs.statSync(file).size;
                const offset = offsets.get(file) ?? 0;
                if (size <= offset) {
                    if (size < offset) {
                        offsets.set(file, size);
                    }
                    continue;
                }
                const stream = fs.createReadStream(file, { start: offset, encoding: "utf8" });
                for await (const chunk of stream) {
                    for (const line of String(chunk).split("\n")) {
                        if (line.length > 0 && (filter === null || filter.test(line))) {
                            process.stdout.write(`${line}\n`);
                        }
                    }
                }
                offsets.set(file, size);
            }
        }
    }
}

async function stopRecorded(stack) {
    for (const runtime of Array.isArray(stack.runtimes) ? stack.runtimes : []) {
        if (typeof runtime.connectionId === "string" && /^mcn_[a-f0-9]{32}$/u.test(runtime.connectionId)) {
            log(`stopping paired connection ${runtime.connectionId}`);
            try {
                const mobiusStateDirectory = path.join(stack.stateDir, "mobius");
                const environment =
                    runtime.mobiusStateDirectory === mobiusStateDirectory
                        ? { MOBIUS_STATE_DIRECTORY: mobiusStateDirectory }
                        : {};
                await run(
                    process.execPath,
                    [
                        path.join(MOBIUS_ROOT, "packages/cli/src/cli/entrypoint.ts"),
                        "pair",
                        "stop",
                        "--connection",
                        runtime.connectionId,
                    ],
                    { env: environment },
                );
            } catch (cause) {
                log(`could not stop paired connection: ${cause instanceof Error ? cause.message : String(cause)}`);
            }
        }
        await stopProcess(runtime.runtimePid);
    }
    const mobiusStateDirectory = path.join(stack.stateDir, "mobius");
    if (fs.existsSync(mobiusStateDirectory)) {
        log(`stopping the Mobius manager at ${mobiusStateDirectory}`);
        try {
            await run(process.execPath, [path.join(MOBIUS_ROOT, "packages/cli/src/cli/entrypoint.ts"), "quit"], {
                env: { MOBIUS_STATE_DIRECTORY: mobiusStateDirectory },
            });
        } catch (cause) {
            log(`could not stop the Mobius manager: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    }
    if (stack.chatPid !== undefined) {
        log(`stopping Chat Worker (pid ${stack.chatPid})`);
        await stopProcess(stack.chatPid);
    }
    if (stack.webPid !== undefined) {
        await stopProcess(stack.webPid);
    }
    if (stack.platformPid !== undefined) {
        log(`stopping Platform (pid ${stack.platformPid})`);
        await stopProcess(stack.platformPid);
    }
}

async function remove(options) {
    const stack = options.stateDir === undefined ? null : readStack(options.stateDir);
    if (stack === null) {
        if (options.stateDir !== undefined && fs.existsSync(options.stateDir)) {
            log("no stack record found; deleting the state directory");
            if (options.keepState !== true) {
                fs.rmSync(options.stateDir, { recursive: true, force: true });
            }
            return;
        }
        fail("pass --state-dir for a stack created by prepare");
    }
    await stopRecorded(stack);
    if (options.keepState !== true) {
        log(`deleting ${stack.stateDir}`);
        fs.rmSync(stack.stateDir, { recursive: true, force: true });
    }
}

function usage(stream = process.stdout) {
    stream.write(
        [
            "Usage:",
            "  node scripts/local-dev.cjs prepare <web|web-server|web-server-mobius|web-server-mobius-cli> [--state-dir DIR] [--platform-port N] [--chat-port N] [--app-id ID --app-secret SECRET] [--force] [--no-build] [--background]",
            "  node scripts/local-dev.cjs setup  --state-dir DIR --harness ID --session-id ID [--workspace DIR]",
            "  node scripts/local-dev.cjs status --state-dir DIR",
            "  node scripts/local-dev.cjs logs   --state-dir DIR [--worker chat|platform|runtime|all] [--lines N] [--filter REGEX] [--follow]",
            "  node scripts/local-dev.cjs remove --state-dir DIR [--keep-state]",
            "",
        ].join("\n"),
    );
}

const COMMANDS = new Set(["prepare", "setup", "status", "logs", "remove"]);
const HELP_COMMANDS = new Set(["help", "--help", "-h"]);

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (HELP_COMMANDS.has(options.command)) {
        usage();
        return;
    }
    if (!COMMANDS.has(options.command)) {
        usage(process.stderr);
        fail(`unknown command "${options.command}"`);
    }
    switch (options.command) {
        case "prepare":
            await prepare(options);
            break;
        case "setup":
            await setup(options);
            break;
        case "status":
            await status(options);
            break;
        case "logs":
            await logs(options);
            break;
        case "remove":
            await remove(options);
            break;
    }
}

main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
});
