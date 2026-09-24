#!/usr/bin/env node
"use strict";

// Local full-stack development helper for Morty.
//
// Dependency-free CommonJS. Requires the repository's pinned Node.js (>= 24).
//
//   node scripts/local-dev.cjs prepare [options]
//   node scripts/local-dev.cjs pair    --state-dir <dir> [options]
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

const REPO_ROOT = path.resolve(__dirname, "..");
const WRANGLER = path.join(REPO_ROOT, "node_modules", ".bin", "wrangler");
const PLATFORM_CONFIG = "packages/e2e/fixtures/wrangler.platform.jsonc";
const CHAT_CONFIG = "packages/e2e/fixtures/wrangler.chat.jsonc";
const MOBIUS_ROOT = path.join(REPO_ROOT, "third-party", "mobius");
const MOBIUS_LOCKFILE = path.join(MOBIUS_ROOT, "pnpm-lock.yaml");
const MOBIUS_INSTALLED_LOCKFILE = path.join(MOBIUS_ROOT, "node_modules", ".pnpm", "lock.yaml");
const SETUP_BUNDLE = "packages/setup/dist/setup.mjs";
const CHAT_ATTACHMENTS_BUCKET = "morty-local-e2e-attachments";
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

function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd ?? REPO_ROOT,
            env: { ...process.env, ...options.env },
            stdio: ["ignore", "pipe", "pipe"],
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

function startProcess(name, args, logPath, command = WRANGLER, env = {}, cwd = REPO_ROOT) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const output = fs.openSync(logPath, "a", 0o600);
    const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        detached: true,
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
    if (!isAlive(pid)) {
        return;
    }
    const signal = (name) => {
        try {
            process.kill(-pid, name);
        } catch {
            try {
                process.kill(pid, name);
            } catch {
                // Already gone.
            }
        }
    };
    signal("SIGTERM");
    const deadline = Date.now() + 10_000;
    while (isAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (isAlive(pid)) {
        signal("SIGKILL");
    }
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

function clerkPublishableKey() {
    const configured = process.env.CHAT_LOCAL_CLERK_PUBLISHABLE_KEY;
    if (configured !== undefined && /^pk_(test|live)_[A-Za-z0-9_-]+$/u.test(configured)) {
        return configured;
    }
    const fixture = path.join(REPO_ROOT, "packages/e2e/infra/test-runtime.ts");
    if (fs.existsSync(fixture)) {
        const match = fs.readFileSync(fixture, "utf8").match(/publishableKey:\s*"([^"]+)"/u);
        if (match !== null && /^pk_(test|live)_[A-Za-z0-9_-]+$/u.test(match[1])) {
            return match[1];
        }
    }
    // A syntactically valid local-only key. The browser cannot load Clerk JS
    // from it, which only matters when a sign-in flow is under test.
    return "pk_test_local_dev_placeholder";
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
    const pid = startProcess(
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
        const platformPid = startProcess(
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

        const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2_048 });
        const variables = {
            APP_ORIGIN: chatOrigin,
            AUTHENTICATION_BASE_URL: chatOrigin,
            CLERK_JWT_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
            CLERK_PUBLISHABLE_KEY: clerkPublishableKey(),
            MOBIUS_APP_ID: appId,
            MOBIUS_APP_SECRET: appSecret,
            MOBIUS_BASE_URL: platformOrigin,
        };
        const variableArguments = Object.entries(variables).flatMap(([key, value]) => ["--var", `${key}:${value}`]);

        log("starting Chat Worker");
        const chatPid = startProcess(
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

const PAIR_READY_TIMEOUT_MILLISECONDS = 300_000;

function readPairRecord(line) {
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
 * Runs the Chat-served setup bundle's `pair` flow with Morty's writable
 * location isolated under the stack's state directory. `documents/` isolates
 * Morty's saved setup files, while Mobius uses its normal singleton manager and
 * connection state. `workspace/` is the paired default workspace.
 */
async function pair(options) {
    const stack = options.stateDir === undefined ? null : readStack(options.stateDir);
    if (stack === null) {
        fail("pass --state-dir for a stack created by prepare");
    }
    if (!isAlive(stack.chatPid)) {
        fail("the stack's Chat Worker is not running; run prepare first");
    }
    const harness = options.harness ?? "codex";
    const documents = path.join(stack.stateDir, "documents");
    const workspace = path.resolve(options.workspace ?? path.join(stack.stateDir, "workspace"));
    for (const directory of [documents, workspace]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const origin = new URL(stack.chatOrigin).origin;

    log("minting a browser identity and pairing ticket");
    const identity = await httpJson(`${origin}/morty/api/identity/anonymous-users`, { body: {} });
    const token = typeof identity.token === "string" ? identity.token : "";
    const projectId = typeof identity.projectId === "string" ? identity.projectId : "";
    const botId = typeof identity.bot === "object" && identity.bot !== null ? identity.bot.botId : undefined;
    if (token.length === 0 || projectId.length === 0 || typeof botId !== "string" || botId.length === 0) {
        fail("the Chat Worker did not return a usable anonymous identity");
    }
    const pairing = await httpJson(`${origin}/morty/api/projects/${encodeURIComponent(projectId)}/identity/pairings`, {
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: { botId },
    });
    const ticket = new URL(typeof pairing.url === "string" ? pairing.url : "about:invalid");
    const pairingToken = ticket.searchParams.get("token") ?? "";
    if (pairingToken.length === 0) {
        fail("the Chat Worker did not return a pairing instruction URL");
    }

    log(`downloading the setup bundle from ${origin}`);
    const setupBundle = path.join(stack.stateDir, "setup.mjs");
    const setupResponse = await fetch(`${origin}/setup.mjs`, { signal: AbortSignal.timeout(20_000) });
    if (!setupResponse.ok) {
        fail(`downloading setup.mjs failed (${setupResponse.status})`);
    }
    fs.writeFileSync(setupBundle, Buffer.from(await setupResponse.arrayBuffer()), { mode: 0o600 });

    const pairLog = path.join(stack.stateDir, "pair.log");
    fs.writeFileSync(pairLog, "", { mode: 0o600 });
    const shimDirectory = path.join(stack.stateDir, "local-cli-bin");
    fs.mkdirSync(shimDirectory, { recursive: true, mode: 0o700 });
    const shim = path.join(shimDirectory, "mobius");
    fs.writeFileSync(
        shim,
        `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [${JSON.stringify(path.join(MOBIUS_ROOT, "packages/cli/src/cli.ts"))}, ...args], {
    stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
        { mode: 0o700 },
    );
    log(`pairing harness "${harness}" against workspace ${workspace}`);
    const runtimePid = startProcess(
        "pair runtime",
        [setupBundle, "pair", "--base-url", origin, "--cwd", workspace, "--token", pairingToken, "--harness", harness],
        pairLog,
        process.execPath,
        {
            DOCUMENT_DIR: documents,
            PATH: `${shimDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        workspace,
    );

    const deadline = Date.now() + PAIR_READY_TIMEOUT_MILLISECONDS;
    let ready = null;
    let runtimeId = null;
    for (;;) {
        const records = fs
            .readFileSync(pairLog, "utf8")
            .split("\n")
            .filter((line) => line.length > 0)
            .map(readPairRecord);
        const failure = records.findLast((record) => record !== null && record.error !== undefined);
        if (failure !== undefined && failure !== null) {
            await stopProcess(runtimePid);
            fail(`pair failed: ${JSON.stringify(failure.error)}`);
        }
        const selected = records.findLast(
            (record) => record !== null && (record.status === "runtime_reused" || record.status === "runtime_paired"),
        );
        if (selected !== undefined && selected !== null && typeof selected.runtimeId === "string") {
            runtimeId = selected.runtimeId;
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
        fail(`the pair runtime did not report ready within ${PAIR_READY_TIMEOUT_MILLISECONDS / 1000}s; see ${pairLog}`);
    }
    if (runtimeId === null) {
        fail("the pair runtime did not report its Runtime ID");
    }
    const pairList = path.join(stack.stateDir, `.pair-list-${crypto.randomUUID()}.json`);
    fs.writeFileSync(pairList, "", { mode: 0o600, flag: "wx" });
    let connectionId;
    try {
        await run(process.execPath, [
            path.join(MOBIUS_ROOT, "packages/cli/src/cli.ts"),
            "pair",
            "list",
            `--output-json=${pairList}`,
        ]);
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
            fail("Mobius did not report the paired connection");
        }
        connectionId = connection.connection_id;
    } finally {
        fs.rmSync(pairList, { force: true });
    }

    const record = {
        chatOrigin: stack.chatOrigin,
        pairLog,
        runtimePid,
        browserIdentity: { token, userId: identity.userId, projectId },
        botId,
        connectionId,
        harness,
        documents,
        workspace,
    };
    const previous = Array.isArray(stack.runtimes) ? stack.runtimes : [];
    writeStack({ ...stack, runtimes: [...previous, record] });
    process.stdout.write(`${JSON.stringify(record)}\n`);
    log("pair is ready; inject browserIdentity into localStorage to open Chat as this user");
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
    const runtimeLogs = (Array.isArray(stack.runtimes) ? stack.runtimes : []).map((runtime) => runtime.pairLog);
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
                await run(process.execPath, [
                    path.join(MOBIUS_ROOT, "packages/cli/src/cli.ts"),
                    "pair",
                    "stop",
                    "--connection",
                    runtime.connectionId,
                ]);
            } catch (cause) {
                log(`could not stop paired connection: ${cause instanceof Error ? cause.message : String(cause)}`);
            }
        }
        await stopProcess(runtime.runtimePid);
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

function usage() {
    process.stdout.write(
        [
            "Usage:",
            "  node scripts/local-dev.cjs prepare <web|web-server|web-server-mobius|web-server-mobius-cli> [--state-dir DIR] [--platform-port N] [--chat-port N] [--app-id ID --app-secret SECRET] [--force] [--no-build] [--background]",
            "  node scripts/local-dev.cjs pair    --state-dir DIR [--harness ID] [--workspace DIR]",
            "  node scripts/local-dev.cjs status --state-dir DIR",
            "  node scripts/local-dev.cjs logs   --state-dir DIR [--worker chat|platform|runtime|all] [--lines N] [--filter REGEX] [--follow]",
            "  node scripts/local-dev.cjs remove --state-dir DIR [--keep-state]",
            "",
        ].join("\n"),
    );
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    switch (options.command) {
        case "prepare":
            await prepare(options);
            break;
        case "pair":
            await pair(options);
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
        default:
            usage();
            break;
    }
}

main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
});
