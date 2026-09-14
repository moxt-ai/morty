import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]);
const emit = (value) => console.log(JSON.stringify({ time: new Date().toISOString(), ...value }));
const executeFile = promisify(execFile);

function progress(stage, message) {
    emit({ status: "progress", stage, message });
}

function fail(code) {
    throw Object.assign(new Error(code), { code });
}

function object(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail("INVALID_RESPONSE");
    }
    return value;
}

function text(value, pattern = /^.+$/u) {
    if (typeof value !== "string" || !pattern.test(value)) {
        fail("INVALID_RESPONSE");
    }
    return value;
}

const identifier = (value) => text(value, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u);
const credential = (value) => text(value, /^mobius_anon_v1_[A-Za-z0-9_-]{43}$/u);

function origin(value) {
    const url = new URL(text(value));
    if (
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
            !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    ) {
        fail("INVALID_ORIGIN");
    }
    return url.origin;
}

async function privatePath(path, directory) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid()) {
        fail("UNSAFE_CONFIG_PATH");
    }
    await chmod(path, directory ? 0o700 : 0o600);
}

async function prepareDirectory(documents) {
    if (!isAbsolute(text(documents))) {
        fail("DOCUMENT_DIR_REQUIRED");
    }
    const directory = join(await realpath(documents), "mobius-chat");
    await mkdir(directory, { mode: 0o700, recursive: true });
    await privatePath(directory, true);
    return directory;
}

async function acquireLock(directory) {
    const lock = join(directory, ".setup-lock");
    try {
        await mkdir(lock, { mode: 0o700 });
    } catch (cause) {
        if (cause.code === "EEXIST") {
            fail("SETUP_BUSY");
        }
        throw cause;
    }
    return lock;
}

async function listLocalProcesses(parent) {
    const { stdout } = await executeFile("ps", ["-ww", "-axo", "pid=,uid=,stat=,args="], {
        signal: parent,
        timeout: 2000,
        maxBuffer: 4 * 1024 * 1024,
    }).catch((cause) => {
        parent.throwIfAborted();
        throw Object.assign(new Error("PROCESS_SCAN_FAILED", { cause }), { code: "PROCESS_SCAN_FAILED" });
    });
    return stdout.split("\n").flatMap((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u);
        if (match === null) {
            return [];
        }
        const pid = Number(match[1]);
        const uid = Number(match[2]);
        return Number.isSafeInteger(pid) &&
            pid > 1 &&
            pid !== process.pid &&
            uid === process.getuid() &&
            !match[3].includes("Z")
            ? [{ pid, uid, command: match[4] }]
            : [];
    });
}

async function isMobiusRuntime(processInfo, parent) {
    const match = processInfo.command.match(/^(?:\S*\/)?(?:node|bun)\s+(?:--\S+\s+)*(.+?)\s+(?:pair|start)(?:\s|$)/u);
    if (match === null || !isAbsolute(match[1])) {
        return false;
    }
    try {
        const script = await realpath(match[1]);
        const packageRoot = dirname(dirname(script));
        const metadata = object(
            JSON.parse(await readFile(join(packageRoot, "package.json"), { encoding: "utf8", signal: parent })),
        );
        return (
            metadata.name === "@moxt-ai/mobius" &&
            object(metadata.bin).mobius === "dist/cli.js" &&
            (script === join(packageRoot, "dist", "cli.js") || script === join(packageRoot, "src", "cli.ts"))
        );
    } catch {
        parent.throwIfAborted();
        // Only a resolved, identifiable CLI entry point authorizes signalling this PID.
        return false;
    }
}

async function stopLocalRuntimes() {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const candidates = await listLocalProcesses(deadline);
    const targets = [];
    for (const candidate of candidates) {
        if (await isMobiusRuntime(candidate, deadline)) {
            targets.push(candidate);
        }
    }
    const current = await listLocalProcesses(deadline);
    for (const target of targets) {
        deadline.throwIfAborted();
        if (!current.some((item) => item.pid === target.pid && item.command === target.command)) {
            continue;
        }
        try {
            process.kill(target.pid, "SIGTERM");
        } catch (cause) {
            if (cause.code !== "ESRCH") {
                throw Object.assign(new Error("RUNTIME_STOP_FAILED", { cause }), { code: "RUNTIME_STOP_FAILED" });
            }
        }
    }
    // Bound process-table reconciliation by both attempts and an overall deadline.
    // Process discovery is asynchronous; no fixed sleeps delay graceful shutdown.
    for (let attempt = 0; attempt < 1000; attempt += 1) {
        const remaining = await listLocalProcesses(deadline);
        if (
            !targets.some((target) =>
                remaining.some((item) => item.pid === target.pid && item.command === target.command),
            )
        ) {
            emit({ status: "runtimes_stopped", count: targets.length });
            return;
        }
    }
    fail("RUNTIME_STOP_TIMEOUT");
}

async function readPrivateJson(path) {
    await privatePath(path, false);
    return object(JSON.parse(await readFile(path, "utf8")));
}

async function writePrivateJson(path, value) {
    const file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
    );
    try {
        await file.writeFile(JSON.stringify(value, null, 2));
        await file.sync();
    } finally {
        await file.close();
    }
}

async function loadConfiguration(directory, base) {
    let config = {};
    try {
        config = await readPrivateJson(join(directory, "config.json"));
    } catch (cause) {
        if (cause.code !== "ENOENT") {
            throw cause;
        }
    }
    if (config.base_url !== undefined && config.base_url !== base) {
        fail("ENVIRONMENT_CONFLICT");
    }
    return { directory, base, config };
}

async function saveConfiguration(context, updates) {
    const config = { ...context.config, ...updates, base_url: context.base };
    const temporary = join(context.directory, `.config-${crypto.randomUUID()}`);
    try {
        await writePrivateJson(temporary, config);
        await rename(temporary, join(context.directory, "config.json"));
        return { ...context, config };
    } finally {
        await rm(temporary, { force: true });
    }
}

async function request(context, route, body, authenticated = true) {
    const headers = { "content-type": "application/json" };
    if (authenticated) {
        headers.authorization = `Bearer ${credential(context.config.user_token)}`;
    }
    const response = await fetch(new URL(`/mobius-cloud/api${route}`, context.base), {
        method: body === undefined ? "GET" : "POST",
        headers,
        redirect: "error",
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    });
    const value = object(await response.json());
    if (!response.ok) {
        fail(text(object(value.error).code, /^[A-Za-z0-9_-]+$/u));
    }
    return value;
}

function readOptions() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: { token: { type: "string" }, harness: { type: "string" } },
    });
    if (positionals.length !== 1 || !["pair", "setup"].includes(positionals[0])) {
        fail("INVALID_ARGUMENTS");
    }
    if (values.harness === undefined) {
        fail("HARNESS_REQUIRED");
    }
    const harness = identifier(values.harness);
    if (positionals[0] === "pair") {
        if (values.token === undefined) {
            fail("PAIRING_TICKET_REQUIRED");
        }
        return { mode: "pair", harness, token: text(values.token, /^[A-Za-z0-9_-]{43}$/u) };
    }
    if (values.token !== undefined) {
        fail("INVALID_ARGUMENTS");
    }
    return { mode: "setup", harness };
}

async function recoverOrRedeemTicket(context, ticket, ticketHash) {
    const recovery = join(context.directory, "pairing-recovery.json");
    try {
        const saved = await readPrivateJson(recovery);
        if (saved.base_url !== context.base) {
            fail("ENVIRONMENT_CONFLICT");
        }
        if (saved.ticket_hash !== ticketHash) {
            fail("PAIRING_RECOVERY_CONFLICT");
        }
        return object(saved.identity);
    } catch (cause) {
        if (cause.code !== "ENOENT") {
            throw cause;
        }
    }
    const identity = await request(context, "/identity/pairings/redeem", { token: ticket }, false);
    credential(identity.token);
    identifier(identity.botId);
    identifier(identity.userId);
    identifier(identity.projectId);
    // Preserve the redeemed credential before checking compatibility with local state.
    await writePrivateJson(recovery, { base_url: context.base, ticket_hash: ticketHash, identity });
    return identity;
}

async function preparePairIdentity(context, ticket) {
    const ticketHash = createHash("sha256").update(ticket).digest("hex");
    if (context.config.pair_ticket_hash === ticketHash) {
        progress("identity", "Resuming the saved web identity and Bot.");
        return context;
    }
    progress("identity", "Exchanging the one-time ticket for the existing user, Bot, and Project.");
    const identity = await recoverOrRedeemTicket(context, ticket, ticketHash);
    if (context.config.user_token !== undefined) {
        const current = await request(context, "/session");
        if (
            current.userId !== identity.userId ||
            (context.config.bot_id !== undefined && context.config.bot_id !== identity.botId)
        ) {
            fail("IDENTITY_CONFLICT");
        }
    }
    const saved = await saveConfiguration(context, {
        user_token: credential(identity.token),
        user_id: identifier(identity.userId),
        bot_id: identifier(identity.botId),
        project_id: identifier(identity.projectId),
        entry: "pair",
        pair_ticket_hash: ticketHash,
    });
    await rm(join(context.directory, "pairing-recovery.json"));
    return saved;
}

async function prepareIdentity(context, options) {
    if (options.mode === "pair") {
        return await preparePairIdentity(context, options.token);
    }
    if (context.config.user_token !== undefined) {
        progress("identity", "Reusing the saved identity.");
        return context;
    }
    progress("identity", "Creating the standalone identity and Bot.");
    const identity = await request(context, "/identity/anonymous-users", {}, false);
    return await saveConfiguration(context, {
        user_token: credential(identity.token),
        user_id: identifier(identity.userId),
        bot_id: identifier(object(identity.bot).botId),
        entry: "setup",
    });
}

async function verifyIdentityAndBot(context, mode) {
    const session = await request(context, "/session");
    identifier(session.userId);
    if (mode === "pair" && context.config.entry !== "pair") {
        fail("PAIRING_TICKET_REQUIRED");
    }
    const listed = await request(context, "/management/bots");
    if (!Array.isArray(listed.bots)) {
        fail("INVALID_RESPONSE");
    }
    const bot = listed.bots
        .map(object)
        .find((item) => context.config.bot_id === undefined || item.botId === context.config.bot_id);
    if (bot === undefined) {
        fail("BOT_NOT_FOUND");
    }
    return await saveConfiguration(context, { user_id: session.userId, bot_id: identifier(bot.botId) });
}

async function prepareRuntimePairing(context) {
    progress("pairing", "Preparing the Runtime connection.");
    let prepared = context;
    if (context.config.pairing === undefined) {
        const saved = await saveConfiguration(context, {
            pairing_key:
                context.config.pairing_key === undefined ? crypto.randomUUID() : identifier(context.config.pairing_key),
        });
        const pairing = await request(saved, "/management/runtime-pairings", {
            idempotencyKey: saved.config.pairing_key,
        });
        origin(pairing.relayUrl);
        identifier(pairing.pairingId);
        identifier(pairing.runtimeId);
        identifier(pairing.channelId);
        identifier(pairing.projectId);
        if (saved.config.project_id !== undefined && saved.config.project_id !== pairing.projectId) {
            fail("PROJECT_CONFLICT");
        }
        text(pairing.pairingCode, /^[A-Za-z0-9-]+$/u);
        prepared = await saveConfiguration(saved, { pairing, project_id: pairing.projectId });
    }
    emit({ status: "prepared", botId: context.config.bot_id });
    return prepared;
}

async function readPairingStatus(context) {
    const pairing = object(context.config.pairing);
    return await request(context, `/management/runtime-pairings/${identifier(pairing.pairingId)}`);
}

async function runtimeArguments(context) {
    const pairing = object(context.config.pairing);
    identifier(pairing.runtimeId);
    const relay = origin(pairing.relayUrl);
    const status = await readPairingStatus(context);
    if (!["pending", "paired"].includes(status.status)) {
        fail("RUNTIME_PAIRING_UNAVAILABLE");
    }
    return status.status === "paired"
        ? ["start", "--channel", identifier(pairing.channelId)]
        : [
              "pair",
              "--url",
              relay,
              "--pairing",
              identifier(pairing.pairingId),
              "--code",
              text(pairing.pairingCode, /^[A-Za-z0-9-]+$/u),
          ];
}

async function startRuntime(context, args) {
    signal.throwIfAborted();
    const logPath = join(context.directory, `runtime-${crypto.randomUUID()}.log`);
    const log = await open(
        logPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
    );
    let child;
    try {
        child = spawn("npx", ["--yes", "@moxt-ai/mobius@latest", ...args], {
            detached: true,
            stdio: ["ignore", log.fd, log.fd],
        });
        await once(child, "spawn", { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
        if (!Number.isSafeInteger(child.pid) || child.pid < 2) {
            fail("RUNTIME_START_FAILED");
        }
        const saved = await saveConfiguration(context, { runtime_process: { pid: child.pid, log_path: logPath } });
        signal.throwIfAborted();
        // Ownership transfers to the saved process record. No agent terminal is needed.
        child.unref();
        emit({ status: "runtime_started", pid: child.pid, logPath });
        return saved;
    } catch (cause) {
        if (child?.pid !== undefined) {
            try {
                process.kill(-child.pid, "SIGTERM");
            } catch (cleanup) {
                if (cleanup.code !== "ESRCH") {
                    throw new AggregateError([cause, cleanup], "Runtime startup cleanup failed");
                }
            }
        }
        throw cause;
    } finally {
        await log.close();
    }
}

async function waitForRuntime(context, harness) {
    const runtimeId = identifier(object(context.config.pairing).runtimeId);
    let attempts = 0;
    while (true) {
        signal.throwIfAborted();
        const status = await readPairingStatus(context);
        if (!["pending", "paired"].includes(status.status)) {
            fail("RUNTIME_PAIRING_UNAVAILABLE");
        }
        if (attempts++ % 10 === 0) {
            progress(
                "runtime",
                status.status === "pending"
                    ? "Waiting for Runtime pairing to complete."
                    : `Waiting for the Runtime and ${harness} to come online.`,
            );
        }
        if (status.status === "paired") {
            if (status.runtimeId !== runtimeId || !Array.isArray(status.agents)) {
                fail("INVALID_RESPONSE");
            }
            if (!status.agents.some((agent) => object(agent).id === harness)) {
                emit({
                    status: "harness_unavailable",
                    harness,
                    available: status.agents.map((agent) => identifier(object(agent).id)),
                });
                fail("HARNESS_UNAVAILABLE");
            }
            const workspace = await request(context, `/chat/bots/${context.config.bot_id}/workspace`, {});
            if (
                Array.isArray(workspace.agents) &&
                workspace.agents.some(
                    (agent) =>
                        object(agent).runtimeId === runtimeId && agent.agentRef === harness && agent.online === true,
                )
            ) {
                emit({ status: "runtime_online", runtimeId, harness });
                return;
            }
        }
        await delay(1000, undefined, { signal });
    }
}

async function bindAgent(context, harness) {
    progress("binding", `Connecting the Bot to ${harness} in the default workspace.`);
    const runtimeId = identifier(object(context.config.pairing).runtimeId);
    const agentRef = identifier(harness);
    const revision = context.config.agent_ref === agentRef ? (context.config.agent_config_revision ?? 1) : 1;
    if (!Number.isSafeInteger(revision) || revision < 1) {
        fail("AGENT_REVISION_REQUIRED");
    }
    await request(context, `/chat/bots/${context.config.bot_id}/setup`, {
        runtimeId,
        agentRef,
        workspaceRef: "default",
        agentConfigRevision: revision,
    });
    const saved = await saveConfiguration(context, { agent_ref: agentRef, agent_config_revision: revision });
    emit({ status: "binding_requested", botId: context.config.bot_id, harness });
    return saved;
}

function hasReadyBinding(context, workspace) {
    const runtimeId = identifier(object(context.config.pairing).runtimeId);
    if (workspace.selected === null) {
        return false;
    }
    const selected = object(workspace.selected);
    if (
        workspace.status !== "active" ||
        selected.runtimeId !== runtimeId ||
        selected.agentRef !== context.config.agent_ref ||
        selected.workspaceRef !== "default" ||
        selected.agentConfigRevision !== context.config.agent_config_revision ||
        !Array.isArray(workspace.agents) ||
        !workspace.agents.some(
            (item) =>
                object(item).runtimeId === runtimeId && item.agentRef === selected.agentRef && item.online === true,
        )
    ) {
        return false;
    }
    return true;
}

async function waitForReadiness(context) {
    let attempts = 0;
    while (true) {
        signal.throwIfAborted();
        const workspace = await request(context, `/chat/bots/${context.config.bot_id}/workspace`, {});
        if (hasReadyBinding(context, workspace)) {
            return;
        }
        if (!["draft", "active"].includes(workspace.status)) {
            fail("BOT_UNAVAILABLE");
        }
        if (attempts++ % 10 === 0) {
            progress("approval", "Waiting for the Runtime to approve and activate the Bot binding.");
        }
        await delay(1000, undefined, { signal });
    }
}

async function finishSetup(context, mode) {
    await waitForReadiness(context);
    const botId = context.config.bot_id;
    if (mode === "pair") {
        emit({
            status: "ready",
            botId,
            url: context.base,
            message: "Return to your Mobius Chat page to start chatting. Keep the Runtime online.",
        });
        return;
    }
    const transfer = await request(context, "/identity/transfers", {});
    const url = new URL(text(transfer.url));
    if (
        url.origin !== context.base ||
        url.pathname !== "/continue" ||
        !new URLSearchParams(url.hash.slice(1)).has("code")
    ) {
        fail("INVALID_HANDOFF");
    }
    emit({ status: "ready", botId, url: url.toString(), expiresAt: text(transfer.expiresAt) });
}

async function main() {
    const options = readOptions();
    const base = origin(process.env.BASE_URL);
    const directory = await prepareDirectory(process.env.DOCUMENT_DIR);
    const lock = await acquireLock(directory);
    try {
        let context = await loadConfiguration(directory, base);
        progress("shutdown", "Stopping existing local Mobius Runtime processes.");
        await stopLocalRuntimes();
        context = await prepareIdentity(context, options);
        context = await verifyIdentityAndBot(context, options.mode);
        emit({ status: "identity_ready", userId: context.config.user_id, botId: context.config.bot_id });
        context = await prepareRuntimePairing(context);
        context = await startRuntime(context, await runtimeArguments(context));
        await waitForRuntime(context, options.harness);
        context = await bindAgent(context, options.harness);
        await finishSetup(context, options.mode);
    } finally {
        await rm(lock, { recursive: true, force: true });
    }
}

try {
    await main();
} catch (cause) {
    emit({
        error: {
            code: controller.signal.aborted
                ? "CANCELLED"
                : signal.aborted
                  ? "SETUP_TIMEOUT"
                  : typeof cause.code === "string"
                    ? cause.code
                    : cause.name === "TimeoutError"
                      ? "TIMEOUT"
                      : "SETUP_FAILED",
        },
    });
    process.exitCode = 1;
}
