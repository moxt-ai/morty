import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mobiusRepository = join(repository, "third-party", "mobius");
const platformConfiguration = join(repository, "scripts", "fixtures", "wrangler.platform-e2e.jsonc");
const chatConfiguration = join(repository, "scripts", "fixtures", "wrangler.chat-e2e.jsonc");
const keepState = process.env.MOBIUS_E2E_KEEP_STATE === "1";
const timeoutMilliseconds = Number(process.env.MOBIUS_E2E_TIMEOUT_MS ?? 10 * 60 * 1_000);
const deadline = AbortSignal.timeout(timeoutMilliseconds);
const children = [];
let browser;
let temporaryDirectory;

function log(message) {
    process.stdout.write(`[opencode-e2e] ${message}\n`);
}

function object(value, name) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Expected ${name} to be an object`);
    }
    return value;
}

function text(value, name) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Expected ${name}`);
    }
    return value;
}

async function freePort() {
    const server = createServer();
    await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Could not allocate a local port");
    }
    await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    return address.port;
}

async function run(command, args, options = {}) {
    log(`${command} ${args.join(" ")}`);
    return await execute(command, args, {
        cwd: options.cwd ?? repository,
        env: { ...process.env, ...options.env },
        maxBuffer: 16 * 1024 * 1024,
        signal: deadline,
    });
}

async function start(name, command, args, options = {}) {
    const logPath = join(temporaryDirectory, `${name}.log`);
    const output = openSync(logPath, "a", 0o600);
    const child = spawn(command, args, {
        cwd: options.cwd ?? repository,
        detached: true,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", output, output],
    });
    children.push({ child, logPath, name, output });
    await new Promise((resolveSpawn, reject) => {
        child.once("error", reject);
        child.once("spawn", resolveSpawn);
    });
    log(`started ${name} (pid ${child.pid}, log ${logPath})`);
    return child;
}

async function waitFor(url, description, validate = (response) => response.ok) {
    let lastError;
    while (!deadline.aborted) {
        const exited = children.find(({ child }) => child.exitCode !== null);
        if (exited !== undefined) {
            const contents = await readFile(exited.logPath, "utf8");
            throw new Error(`${exited.name} exited with code ${exited.child.exitCode}:\n${contents.slice(-4_000)}`);
        }
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
            if (await validate(response)) {
                return;
            }
            lastError = new Error(`${description} returned HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

async function jsonRequest(origin, path, { body, token, provider } = {}) {
    const headers = { "content-type": "application/json" };
    if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
    }
    if (provider !== undefined) {
        headers["x-mobius-oidc-provider"] = provider;
    }
    const response = await fetch(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: deadline,
    });
    const raw = await response.text();
    let value;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error(`${path} returned invalid JSON (${response.status}): ${raw.slice(0, 500)}`);
    }
    if (!response.ok) {
        throw new Error(`${path} failed (${response.status}): ${raw.slice(0, 1_000)}`);
    }
    return object(value, path);
}

async function resolveOpenCode() {
    const configured = process.env.OPENCODE_BIN ?? process.env.MOBIUS_OPENCODE_PATH;
    if (configured !== undefined && configured.trim().length > 0) {
        const executable = resolve(configured);
        await access(executable, constants.X_OK);
        return executable;
    }
    try {
        return (await execute("sh", ["-c", "command -v opencode"], { signal: deadline })).stdout.trim();
    } catch {
        throw new Error(
            "OpenCode is required. Install it or set OPENCODE_BIN to an OpenCode executable before running this live E2E.",
        );
    }
}

async function selectFreeModel(openCode) {
    const requested = process.env.OPENCODE_E2E_MODEL;
    const { stdout } = await run(openCode, ["models", "opencode"]);
    const models = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => /^opencode\/[A-Za-z0-9._-]+$/u.test(line));
    const selected = requested ?? models.find((model) => model.endsWith("-free"));
    if (selected === undefined || !models.includes(selected)) {
        throw new Error(`No current OpenCode free model is available. Found: ${models.join(", ") || "none"}`);
    }
    return selected;
}

async function clerkPublishableKey() {
    const configured = process.env.MOBIUS_E2E_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY;
    if (configured !== undefined && /^pk_(?:test|live)_[A-Za-z0-9_-]+$/u.test(configured)) {
        return configured;
    }
    try {
        const developmentVariables = await readFile(join(repository, ".dev.vars"), "utf8");
        const value = developmentVariables
            .match(/^CLERK_PUBLISHABLE_KEY=(.+)$/mu)?.[1]
            ?.trim()
            .replace(/^['"]|['"]$/gu, "");
        if (value !== undefined && /^pk_(?:test|live)_[A-Za-z0-9_-]+$/u.test(value) && !value.includes("REPLACE")) {
            return value;
        }
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
    throw new Error(
        "A valid Clerk publishable key is required to initialize the real browser UI. Set MOBIUS_E2E_CLERK_PUBLISHABLE_KEY or configure CLERK_PUBLISHABLE_KEY in .dev.vars.",
    );
}

async function migrate(configuration, binding, persistence, cwd = repository) {
    await run(
        "pnpm",
        [
            "exec",
            "wrangler",
            "d1",
            "migrations",
            "apply",
            binding,
            "--local",
            "--persist-to",
            persistence,
            "--config",
            configuration,
        ],
        { cwd },
    );
}

async function platformApplication(platformOrigin) {
    const authentication = { provider: "e2e", token: "mobius-chat-local-e2e" };
    const tenant = await jsonRequest(platformOrigin, "/mobius/api/v1/platform/tenants", {
        ...authentication,
        body: { displayName: "Mobius Chat live E2E" },
    });
    const application = await jsonRequest(platformOrigin, "/mobius/api/v1/apps", {
        ...authentication,
        body: { displayName: "Mobius Chat live E2E", tenantId: text(tenant.tenantId, "tenantId") },
    });
    return {
        appId: text(application.appId, "appId"),
        appSecret: text(object(application.defaultCredential, "defaultCredential").credential, "credential"),
    };
}

async function waitForOpenCode(chatOrigin, token, pairingId) {
    while (!deadline.aborted) {
        const status = await jsonRequest(
            chatOrigin,
            `/mobius-cloud/api/management/runtime-pairings/${encodeURIComponent(pairingId)}`,
            { token },
        );
        if (
            status.status === "paired" &&
            Array.isArray(status.agents) &&
            status.agents.some((agent) => object(agent, "agent").id === "opencode")
        ) {
            return status;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    throw new Error("Timed out waiting for the local Mobius daemon and OpenCode");
}

async function waitForBinding(chatOrigin, token, botId) {
    while (!deadline.aborted) {
        const workspace = await jsonRequest(
            chatOrigin,
            `/mobius-cloud/api/chat/bots/${encodeURIComponent(botId)}/workspace`,
            { body: {}, token },
        );
        if (
            workspace.status === "active" &&
            workspace.selected !== null &&
            object(workspace.selected, "selected").agentRef === "opencode"
        ) {
            return;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    throw new Error("Timed out waiting for the OpenCode Bot binding");
}

async function main() {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-chat-opencode-e2e-"));
    const platformPort = await freePort();
    const chatPort = await freePort();
    const platformOrigin = `http://127.0.0.1:${platformPort}`;
    const chatOrigin = `http://127.0.0.1:${chatPort}`;
    const platformState = join(temporaryDirectory, "platform");
    const chatState = join(temporaryDirectory, "chat");
    const runtimeState = join(temporaryDirectory, "runtime");
    const openCodeConfiguration = join(temporaryDirectory, "opencode-config", "opencode");
    const workspace = join(temporaryDirectory, "workspace");
    await Promise.all(
        [platformState, chatState, runtimeState, openCodeConfiguration, workspace].map((path) =>
            mkdir(path, { recursive: true }),
        ),
    );

    const openCode = await resolveOpenCode();
    const model = await selectFreeModel(openCode);
    await writeFile(join(openCodeConfiguration, "opencode.json"), `${JSON.stringify({ model }, null, 2)}\n`, {
        mode: 0o600,
    });
    log(`using OpenCode ${await run(openCode, ["--version"]).then(({ stdout }) => stdout.trim())} with ${model}`);

    await run("pnpm", ["--filter", "@moxt-ai/mobius", "build"], { cwd: mobiusRepository });
    await migrate(platformConfiguration, "D1_SHARD_APAC_01", platformState, mobiusRepository);
    await migrate(platformConfiguration, "PLATFORM_DIRECTORY_DATABASE", platformState, mobiusRepository);
    await start(
        "mobius-platform",
        "pnpm",
        [
            "exec",
            "wrangler",
            "dev",
            "--config",
            platformConfiguration,
            "--ip",
            "127.0.0.1",
            "--port",
            String(platformPort),
            "--persist-to",
            platformState,
        ],
        { cwd: mobiusRepository },
    );
    await waitFor(`${platformOrigin}/mobius/api/health`, "mobius-platform");
    const application = await platformApplication(platformOrigin);

    await migrate(chatConfiguration, "DATABASE", chatState);
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const chatVariables = {
        APP_ORIGIN: chatOrigin,
        AUTHENTICATION_BASE_URL: chatOrigin,
        CLERK_JWT_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
        CLERK_PUBLISHABLE_KEY: await clerkPublishableKey(),
        MOBIUS_APP_ID: application.appId,
        MOBIUS_APP_SECRET: application.appSecret,
        MOBIUS_BASE_URL: platformOrigin,
        MOBIUS_PROJECT_LOCATION_HINT: "apac",
        SLACK_MOBIUS_AUTH_TOKEN: "unused-in-opencode-e2e",
        SLACK_OAUTH_STATE_SIGNING_KEY: "unused-in-opencode-e2e",
        SLACK_SERVER_BASE_URL: chatOrigin,
        SLACK_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        VITE_MOBIUS_APP_ID: application.appId,
        VITE_MOBIUS_BASE_URL: platformOrigin,
    };
    await run("pnpm", ["build", "--mode", "e2e"], { env: chatVariables });
    const variableArguments = Object.entries(chatVariables).flatMap(([key, value]) => ["--var", `${key}:${value}`]);
    await start("mobius-chat", "pnpm", [
        "exec",
        "wrangler",
        "dev",
        "--config",
        chatConfiguration,
        "--ip",
        "127.0.0.1",
        "--port",
        String(chatPort),
        "--persist-to",
        chatState,
        ...variableArguments,
    ]);
    await waitFor(chatOrigin, "mobius-chat", (response) => response.status === 200);

    browser = await chromium.launch({
        channel: process.env.MOBIUS_E2E_BROWSER_CHANNEL ?? "chrome",
        headless: true,
    });
    const page = await browser.newPage();
    const identityResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/mobius-cloud/api/identity/anonymous-users",
        { timeout: timeoutMilliseconds },
    );
    await page.goto(chatOrigin, { waitUntil: "domcontentloaded", timeout: timeoutMilliseconds });
    const identity = object(await (await identityResponse).json(), "anonymous identity");
    const token = text(identity.token, "anonymous token");
    const botId = text(object(identity.bot, "bot").botId, "botId");
    const pairing = await jsonRequest(chatOrigin, "/mobius-cloud/api/management/runtime-pairings", {
        body: { idempotencyKey: crypto.randomUUID() },
        token,
    });
    const daemon = await start(
        "mobius",
        process.execPath,
        [
            join(mobiusRepository, "packages", "cli", "dist", "cli.js"),
            "pair",
            "--url",
            text(pairing.relayUrl, "relayUrl"),
            "--pairing",
            text(pairing.pairingId, "pairingId"),
            "--code",
            text(pairing.pairingCode, "pairingCode"),
            "--workspace",
            workspace,
        ],
        {
            env: {
                MOBIUS_OPENCODE_PATH: openCode,
                MOBIUS_STATE_DIRECTORY: runtimeState,
                OPENCODE_DISABLE_AUTOUPDATE: "1",
                XDG_CACHE_HOME: join(temporaryDirectory, "xdg-cache"),
                XDG_CONFIG_HOME: join(temporaryDirectory, "opencode-config"),
                XDG_DATA_HOME: join(temporaryDirectory, "xdg-data"),
                XDG_STATE_HOME: join(temporaryDirectory, "xdg-state"),
            },
        },
    );
    daemon.once("exit", (code) => {
        if (!deadline.aborted && code !== null && code !== 0) {
            log(`mobius daemon exited early with code ${code}`);
        }
    });

    const paired = await waitForOpenCode(chatOrigin, token, text(pairing.pairingId, "pairingId"));
    await jsonRequest(chatOrigin, `/mobius-cloud/api/chat/bots/${encodeURIComponent(botId)}/setup`, {
        body: {
            runtimeId: text(paired.runtimeId, "runtimeId"),
            agentRef: "opencode",
            workspaceRef: "default",
            agentConfigRevision: 1,
        },
        token,
    });
    await waitForBinding(chatOrigin, token, botId);

    const messageBox = page.getByLabel("Message", { exact: true });
    await messageBox.waitFor({ state: "visible", timeout: timeoutMilliseconds });
    const marker = `OPENCODE_LIVE_E2E_${crypto.randomUUID().replaceAll("-", "")}`;
    await messageBox.fill(`Reply with exactly: ${marker}`);
    await page.getByLabel("Send message", { exact: true }).click({ timeout: timeoutMilliseconds });
    await page
        .getByLabel("Agent response")
        .filter({ hasText: marker })
        .waitFor({ state: "visible", timeout: timeoutMilliseconds });
    log(
        `PASS: browser -> local mobius-chat -> local mobius-platform -> local mobius -> OpenCode (${model}) -> ${marker}`,
    );
}

async function cleanup() {
    let cleanupError;
    try {
        await browser?.close();
    } catch (error) {
        cleanupError = error;
    }
    for (const { child, output } of children.toReversed()) {
        try {
            if (child.pid !== undefined) {
                process.kill(-child.pid, "SIGTERM");
            }
        } catch (error) {
            if (error.code !== "ESRCH" && cleanupError === undefined) {
                cleanupError = error;
            }
        }
        closeSync(output);
    }
    if (temporaryDirectory !== undefined && !keepState) {
        await rm(temporaryDirectory, { recursive: true, force: true });
    } else if (temporaryDirectory !== undefined) {
        log(`kept state and logs at ${temporaryDirectory}`);
    }
    if (cleanupError !== undefined) {
        throw cleanupError;
    }
}

try {
    await main();
} catch (error) {
    if (temporaryDirectory !== undefined) {
        for (const { logPath, name } of children) {
            try {
                const contents = await readFile(logPath, "utf8");
                process.stderr.write(`\n--- ${name} (${logPath}) ---\n${contents.slice(-12_000)}\n`);
            } catch {
                // The process may have failed before its log file was created.
            }
        }
    }
    throw error;
} finally {
    await cleanup();
}
