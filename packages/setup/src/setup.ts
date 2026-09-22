import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import jsQrImport from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";

export interface SetupRuntime {
    readonly start: (
        directory: string,
        args: readonly string[],
        cwd: string,
        signal: AbortSignal,
    ) => Promise<{
        readonly pid: number;
        readonly logPath: string;
    }>;
}

export interface SetupHost {
    readonly documents: string;
    readonly signal: AbortSignal;
    readonly emit: (value: Readonly<Record<string, unknown>>) => void;
    readonly runtime?: SetupRuntime;
    readonly clock?: {
        readonly now: () => Date;
        readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    };
}

interface Context {
    readonly directory: string;
    readonly base: string;
    readonly config: Readonly<Record<string, unknown>>;
}

type Options =
    | {
          readonly mode: "pair";
          readonly base: string;
          readonly cwd: string;
          readonly harness: string;
          readonly token: string;
      }
    | {
          readonly mode: "setup";
          readonly base: string;
          readonly cwd: string;
          readonly harness: string;
          readonly sessionId: string;
      };

function errorCode(cause: unknown): unknown {
    return cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined;
}

interface ErrorCause {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly stack?: string;
    readonly cause?: ErrorCause;
    readonly errors?: readonly ErrorCause[];
}

function sanitizeErrorText(value: string) {
    return value
        .replace(/mobius_(?:anon|pair|transfer)_v2\.[A-Za-z0-9._-]+/gu, "[REDACTED]")
        .replace(/([?&](?:token|code)=)[^&\s#]+/giu, "$1[REDACTED]");
}

function serializeErrorCause(cause: unknown, seen = new WeakSet<object>()): ErrorCause {
    if (!(cause instanceof Error)) {
        return {
            name: "UnknownError",
            message: typeof cause === "string" ? sanitizeErrorText(cause) : "Unknown failure",
        };
    }
    if (seen.has(cause)) {
        return { name: cause.name, message: sanitizeErrorText(cause.message) };
    }
    seen.add(cause);
    const code = errorCode(cause);
    const nested = cause.cause === undefined ? undefined : serializeErrorCause(cause.cause, seen);
    const errors =
        cause instanceof AggregateError
            ? [...cause.errors].map((error) => serializeErrorCause(error, seen))
            : undefined;
    return {
        name: cause.name,
        message: sanitizeErrorText(cause.message),
        ...(typeof code === "string" ? { code } : {}),
        ...(cause.stack === undefined ? {} : { stack: sanitizeErrorText(cause.stack) }),
        ...(nested === undefined ? {} : { cause: nested }),
        ...(errors === undefined ? {} : { errors }),
    };
}

export async function runSetup(args: readonly string[], host: SetupHost): Promise<number> {
    const signal = AbortSignal.any([host.signal, AbortSignal.timeout(300000)]);
    const clock = host.clock ?? {
        now: () => new Date(),
        wait: async (milliseconds: number, parent: AbortSignal) => {
            await delay(milliseconds, undefined, { signal: parent });
        },
    };
    const emit = (value: Readonly<Record<string, unknown>>) => host.emit({ time: clock.now().toISOString(), ...value });

    function progress(stage: string, message: string) {
        emit({ status: "progress", stage, message });
    }

    function fail(code: string, cause?: Error): never {
        throw Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code });
    }

    function object(value: unknown): Record<string, unknown> {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            fail("INVALID_RESPONSE");
        }
        return Object.fromEntries(Object.entries(value));
    }

    function text(value: unknown, pattern = /^.+$/u): string {
        if (typeof value !== "string" || !pattern.test(value)) {
            fail("INVALID_RESPONSE");
        }
        return value;
    }

    const identifier = (value: unknown) => text(value, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u);
    const credential = (value: unknown) => text(value, /^mobius_anon_v2_[A-Za-z0-9_-]{43}$/u);

    function origin(value: unknown) {
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

    async function privatePath(path: string, directory: boolean) {
        const stat = await lstat(path);
        if (
            stat.isSymbolicLink() ||
            (directory ? !stat.isDirectory() : !stat.isFile()) ||
            process.getuid === undefined ||
            stat.uid !== process.getuid()
        ) {
            fail("UNSAFE_CONFIG_PATH");
        }
        await chmod(path, directory ? 0o700 : 0o600);
    }

    async function prepareDirectory(documents: string) {
        if (!isAbsolute(text(documents))) {
            fail("DOCUMENT_DIR_REQUIRED");
        }
        const directory = join(await realpath(documents), "mobius-chat");
        await mkdir(directory, { mode: 0o700, recursive: true });
        await privatePath(directory, true);
        return directory;
    }

    async function resolveWorkingDirectory(requested: string) {
        if (!isAbsolute(requested)) {
            fail("WORKING_DIRECTORY_REQUIRED");
        }
        try {
            const resolved = await realpath(requested);
            const stat = await lstat(resolved);
            if (!stat.isDirectory() || process.getuid === undefined || stat.uid !== process.getuid()) {
                fail("UNSAFE_WORKING_DIRECTORY");
            }
            return resolved;
        } catch (cause) {
            if (errorCode(cause) === "UNSAFE_WORKING_DIRECTORY") {
                throw cause;
            }
            fail("WORKING_DIRECTORY_UNAVAILABLE");
        }
    }

    async function acquireLock(directory: string) {
        const lock = join(directory, ".setup-lock");
        try {
            await mkdir(lock, { mode: 0o700 });
        } catch (cause) {
            if (errorCode(cause) === "EEXIST") {
                fail("SETUP_BUSY");
            }
            throw cause;
        }
        return lock;
    }

    async function readPrivateJson(path: string) {
        await privatePath(path, false);
        return object(JSON.parse(await readFile(path, "utf8")));
    }

    async function writePrivateFile(path: string, value: string | Uint8Array) {
        const file = await open(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        try {
            await file.writeFile(value);
            await file.sync();
        } finally {
            await file.close();
        }
    }

    async function writePrivateJson(path: string, value: unknown) {
        await writePrivateFile(path, JSON.stringify(value, null, 2));
    }

    async function loadConfiguration(directory: string, base: string): Promise<Context> {
        let config: Readonly<Record<string, unknown>> = {};
        try {
            config = await readPrivateJson(join(directory, "config.json"));
        } catch (cause) {
            if (errorCode(cause) !== "ENOENT") {
                throw cause;
            }
            return { directory, base, config };
        }
        // Preserve identity and Bot selection, never old credentials or connection state.
        const identity =
            config.base_url !== undefined && config.base_url !== base
                ? {}
                : Object.fromEntries(
                      Object.entries(config).filter(([key]) =>
                          ["user_token", "user_id", "project_id", "bot_id"].includes(key),
                      ),
                  );
        return { directory, base, config: identity };
    }

    async function loadPairCandidate(directory: string): Promise<Readonly<Record<string, unknown>> | null> {
        try {
            return await readPrivateJson(join(directory, "config.json"));
        } catch (cause) {
            if (
                errorCode(cause) === "ENOENT" ||
                errorCode(cause) === "INVALID_RESPONSE" ||
                cause instanceof SyntaxError
            ) {
                return null;
            }
            throw cause;
        }
    }

    async function backupConfiguration(directory: string) {
        const path = join(directory, "config.json");
        try {
            await privatePath(path, false);
        } catch (cause) {
            if (errorCode(cause) === "ENOENT") {
                return;
            }
            throw cause;
        }
        const backupPath = join(directory, `config-backup-${crypto.randomUUID()}.json`);
        await copyFile(path, backupPath, constants.COPYFILE_EXCL);
        emit({ status: "configuration_backed_up", backupPath });
    }

    async function saveConfiguration(context: Context, updates: Readonly<Record<string, unknown>>): Promise<Context> {
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

    async function request(context: Context, route: string, body?: unknown, authenticated = true) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (authenticated) {
            headers.authorization = `Bearer ${credential(context.config.user_token)}`;
        }
        const path =
            authenticated && !route.startsWith("/chat/projects/")
                ? `/projects/${identifier(context.config.project_id)}${route}`
                : route;
        const response = await fetch(new URL(`/mobius-cloud/api${path}`, context.base), {
            method: body === undefined ? "GET" : "POST",
            headers,
            redirect: "error",
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
        });
        const value = object(await response.json());
        if (!response.ok) {
            const failure = object(value.error);
            const code = text(failure.code, /^[A-Za-z0-9_-]+$/u);
            const message =
                typeof failure.message === "string" ? failure.message : `Request failed with HTTP ${response.status}`;
            fail(code, Object.assign(new Error(message), { name: "RemoteError" }));
        }
        return value;
    }

    function readOptions(): Options {
        const { values, positionals } = parseArgs({
            args: [...args],
            allowPositionals: true,
            options: {
                token: { type: "string" },
                cwd: { type: "string" },
                harness: { type: "string" },
                "base-url": { type: "string" },
                "session-id": { type: "string" },
            },
        });
        if (positionals.length !== 1 || !["pair", "setup"].includes(positionals[0])) {
            fail("INVALID_ARGUMENTS");
        }
        if (values.harness === undefined) {
            fail("HARNESS_REQUIRED");
        }
        if (values["base-url"] === undefined) {
            fail("BASE_URL_REQUIRED");
        }
        if (values.cwd === undefined) {
            fail("WORKING_DIRECTORY_REQUIRED");
        }
        const base = origin(values["base-url"]);
        const cwd = text(values.cwd);
        const harness = identifier(values.harness);
        if (positionals[0] === "pair") {
            if (values.token === undefined) {
                fail("PAIRING_TICKET_REQUIRED");
            }
            if (values["session-id"] !== undefined) {
                fail("INVALID_ARGUMENTS");
            }
            return {
                mode: "pair",
                base,
                cwd,
                harness,
                token: text(values.token, /^mobius_pair_v2\.[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{43}$/u),
            };
        }
        if (values.token !== undefined) {
            fail("INVALID_ARGUMENTS");
        }
        if (values["session-id"] === undefined) {
            fail("SESSION_ID_REQUIRED");
        }
        return { mode: "setup", base, cwd, harness, sessionId: identifier(values["session-id"]) };
    }

    async function preparePairIdentity(context: Context, ticket: string) {
        progress("identity", "Exchanging the one-time ticket for the existing user, Bot, and workspace.");
        const identity = await request(context, "/identity/pairings/redeem", { token: ticket }, false);
        const updates = {
            user_token: credential(identity.token),
            user_id: identifier(identity.userId),
            bot_id: identifier(identity.botId),
            project_id: identifier(identity.projectId),
            expected_runtime_id: identity.expectedRuntimeId === null ? null : identifier(identity.expectedRuntimeId),
            entry: "pair",
        };
        return await saveConfiguration(context, updates);
    }

    async function prepareIdentity(context: Context, options: Options) {
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
            project_id: identifier(identity.projectId),
            entry: "setup",
        });
    }

    async function verifyIdentityAndBot(context: Context, mode: Options["mode"]) {
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

    async function prepareRuntimePairing(context: Context) {
        progress("pairing", "Preparing the Runtime connection.");
        let prepared = context;
        if (context.config.pairing === undefined) {
            const saved = await saveConfiguration(context, {
                pairing_key:
                    context.config.pairing_key === undefined
                        ? crypto.randomUUID()
                        : identifier(context.config.pairing_key),
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

    async function readPairingStatus(context: Context) {
        const pairing = object(context.config.pairing);
        return await request(context, `/management/runtime-pairings/${identifier(pairing.pairingId)}`);
    }

    async function reuseSavedRuntime(
        context: Context,
        saved: Readonly<Record<string, unknown>> | null,
        mode: Options["mode"],
        cwd: string,
    ): Promise<Context> {
        if (
            saved === null ||
            saved.base_url !== context.base ||
            saved.user_id !== context.config.user_id ||
            saved.project_id !== context.config.project_id ||
            saved.bot_id !== context.config.bot_id ||
            saved.workspace !== cwd ||
            (mode === "pair" && context.config.expected_runtime_id === null)
        ) {
            return context;
        }
        try {
            const savedPairing = object(saved.pairing);
            const pairing = {
                pairingId: identifier(savedPairing.pairingId),
                projectId: identifier(savedPairing.projectId),
                runtimeId: identifier(savedPairing.runtimeId),
                channelId: identifier(savedPairing.channelId),
                relayUrl: origin(savedPairing.relayUrl),
            };
            if (pairing.projectId !== context.config.project_id) {
                return context;
            }
            if (mode === "pair" && pairing.runtimeId !== identifier(context.config.expected_runtime_id)) {
                return context;
            }
            const candidate = {
                ...context,
                config: {
                    ...context.config,
                    pairing,
                    pairing_key: identifier(saved.pairing_key),
                },
            };
            const status = await readPairingStatus(candidate);
            if (
                status.status !== "paired" ||
                status.projectId !== pairing.projectId ||
                status.runtimeId !== pairing.runtimeId ||
                status.channelId !== pairing.channelId
            ) {
                return context;
            }
            const reused = await saveConfiguration(context, {
                pairing,
                pairing_key: candidate.config.pairing_key,
            });
            emit({ status: "runtime_reused", runtimeId: pairing.runtimeId, channelId: pairing.channelId });
            return reused;
        } catch (cause) {
            signal.throwIfAborted();
            if (errorCode(cause) === "INVALID_RESPONSE" || errorCode(cause) === "NOT_FOUND") {
                return context;
            }
            throw cause;
        }
    }

    async function runtimeArguments(context: Context, cwd: string) {
        const pairing = object(context.config.pairing);
        identifier(pairing.runtimeId);
        const relay = origin(pairing.relayUrl);
        const status = await readPairingStatus(context);
        if (status.status !== "pending" && status.status !== "paired") {
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
                  "--workspace",
                  cwd,
              ];
    }

    async function startRuntime(context: Context, args: string[], cwd: string) {
        signal.throwIfAborted();
        if (host.runtime !== undefined) {
            const started = await host.runtime.start(context.directory, args, cwd, signal);
            const saved = await saveConfiguration(context, {
                runtime_process: { pid: started.pid, log_path: started.logPath },
                workspace: cwd,
            });
            emit({ status: "runtime_started", ...started });
            return saved;
        }
        const logPath = join(context.directory, `runtime-${crypto.randomUUID()}.log`);
        const log = await open(
            logPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        let child: ChildProcess | undefined;
        try {
            child = spawn("npx", ["--yes", "@moxt-ai/mobius@latest", ...args], {
                cwd,
                stdio: ["ignore", log.fd, log.fd],
            });
            await once(child, "spawn", { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
            if (child.pid === undefined || !Number.isSafeInteger(child.pid) || child.pid < 2) {
                fail("RUNTIME_START_FAILED");
            }
            const saved = await saveConfiguration(context, {
                runtime_process: { pid: child.pid, log_path: logPath },
                workspace: cwd,
            });
            signal.throwIfAborted();
            // The Runtime stays attached to this process. It exits with the agent
            // conversation instead of surviving as a background daemon.
            emit({ status: "runtime_started", pid: child.pid, logPath });
            return saved;
        } catch (cause) {
            if (child?.pid !== undefined) {
                try {
                    process.kill(child.pid, "SIGTERM");
                } catch (cleanup) {
                    if (errorCode(cleanup) !== "ESRCH") {
                        throw new AggregateError([cause, cleanup], "Runtime startup cleanup failed");
                    }
                }
            }
            throw cause;
        } finally {
            await log.close();
        }
    }

    async function waitForRuntime(context: Context, harness: string) {
        const runtimeId = identifier(object(context.config.pairing).runtimeId);
        let attempts = 0;
        while (true) {
            signal.throwIfAborted();
            const status = await readPairingStatus(context);
            if (status.status !== "pending" && status.status !== "paired") {
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
                emit({ status: "runtime_paired", runtimeId, harness });
                break;
            }
            await clock.wait(1000, signal);
        }

        attempts = 0;
        while (true) {
            signal.throwIfAborted();
            const workspace = await request(
                context,
                `/chat/projects/${context.config.project_id}/bots/${context.config.bot_id}/workspace`,
                {},
            );
            if (
                Array.isArray(workspace.agents) &&
                workspace.agents.some(
                    (agent) =>
                        object(agent).runtimeId === runtimeId &&
                        object(agent).agentRef === harness &&
                        object(agent).online === true,
                )
            ) {
                emit({ status: "runtime_online", runtimeId, harness });
                return;
            }
            if (attempts++ % 10 === 0) {
                progress("runtime", `Waiting for the Runtime and ${harness} to come online.`);
            }
            await clock.wait(1000, signal);
        }
    }

    async function bindAgent(context: Context, harness: string) {
        progress("binding", `Connecting the Bot to ${harness} in the default workspace.`);
        const runtimeId = identifier(object(context.config.pairing).runtimeId);
        const agentRef = identifier(harness);
        const revision = context.config.agent_ref === agentRef ? (context.config.agent_config_revision ?? 1) : 1;
        if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
            fail("AGENT_REVISION_REQUIRED");
        }
        await request(context, `/chat/projects/${context.config.project_id}/bots/${context.config.bot_id}/setup`, {
            runtimeId,
            agentRef,
        });
        const saved = await saveConfiguration(context, { agent_ref: agentRef, agent_config_revision: revision });
        emit({ status: "binding_activated", botId: context.config.bot_id, harness });
        return saved;
    }

    function hasReadyBinding(context: Context, workspace: Record<string, unknown>) {
        const runtimeId = identifier(object(context.config.pairing).runtimeId);
        if (
            workspace.status !== "active" ||
            workspace.runtimeId !== runtimeId ||
            !Array.isArray(workspace.agents) ||
            !workspace.agents.some(
                (item) =>
                    object(item).runtimeId === runtimeId &&
                    object(item).agentRef === context.config.agent_ref &&
                    object(item).online === true,
            )
        ) {
            return false;
        }
        return true;
    }

    async function waitForReadiness(context: Context) {
        let attempts = 0;
        while (true) {
            signal.throwIfAborted();
            const workspace = await request(
                context,
                `/chat/projects/${context.config.project_id}/bots/${context.config.bot_id}/workspace`,
                {},
            );
            if (hasReadyBinding(context, workspace)) {
                return;
            }
            if (workspace.status !== "draft" && workspace.status !== "active") {
                fail("BOT_UNAVAILABLE");
            }
            if (attempts++ % 10 === 0) {
                progress("activation", "Waiting for the Bot binding to become active.");
            }
            await clock.wait(1000, signal);
        }
    }

    async function createQrCode(context: Context, value: string) {
        const image = await QRCode.toBuffer(value, {
            type: "png",
            errorCorrectionLevel: "M",
            margin: 4,
            width: 512,
        });
        const png = PNG.sync.read(image);
        const decoder: unknown = jsQrImport;
        if (typeof decoder !== "function") {
            fail("QR_DECODER_UNAVAILABLE");
        }
        const decoded: unknown = decoder(new Uint8ClampedArray(png.data), png.width, png.height);
        if (decoded === null || object(decoded).data !== value) {
            fail("QR_VERIFICATION_FAILED");
        }

        const qrText = await QRCode.toString(value, { type: "utf8", errorCorrectionLevel: "M", margin: 2 });
        const qrPath = join(context.directory, "handoff-qr.png");
        const qrTextPath = join(context.directory, "handoff-qr.txt");
        const temporaryImage = join(context.directory, `.handoff-qr-${crypto.randomUUID()}.png`);
        const temporaryText = join(context.directory, `.handoff-qr-${crypto.randomUUID()}.txt`);
        try {
            await writePrivateFile(temporaryImage, image);
            await writePrivateFile(temporaryText, qrText);
            await rename(temporaryImage, qrPath);
            await rename(temporaryText, qrTextPath);
            await privatePath(qrPath, false);
            await privatePath(qrTextPath, false);
        } finally {
            await rm(temporaryImage, { force: true });
            await rm(temporaryText, { force: true });
        }

        return {
            qrPath,
            qrTextPath,
        };
    }

    async function finishSetup(context: Context, options: Options) {
        await waitForReadiness(context);
        const botId = context.config.bot_id;
        const workspace = text(context.config.workspace);
        if (options.mode === "pair") {
            emit({
                status: "ready",
                botId,
                url: context.base,
                workspace,
                message: "Return to your Mobius Chat page to start chatting. Keep the Runtime online.",
            });
            return;
        }
        const transfer = await request(context, "/identity/transfers", {});
        const url = new URL(text(transfer.url));
        if (
            url.origin !== context.base ||
            url.pathname !== "/continue" ||
            url.search !== "" ||
            !new URLSearchParams(url.hash.slice(1)).has("code")
        ) {
            fail("INVALID_HANDOFF");
        }
        url.searchParams.set("harness", options.harness);
        url.searchParams.set("sessionId", options.sessionId);
        const handoffUrl = url.toString();
        const qr = await createQrCode(context, handoffUrl);
        emit({
            status: "ready",
            botId,
            url: handoffUrl,
            expiresAt: text(transfer.expiresAt),
            workspace,
            ...qr,
            message: "Open the link or scan the QR code to chat. Keep the Runtime online.",
        });
    }

    async function main() {
        const options = readOptions();
        const base = options.base;
        const cwd = await resolveWorkingDirectory(options.cwd);
        const directory = await prepareDirectory(host.documents);
        const lock = await acquireLock(directory);
        try {
            const runtimeCandidate = await loadPairCandidate(directory);
            let context: Context =
                options.mode === "setup" ? await loadConfiguration(directory, base) : { directory, base, config: {} };
            await backupConfiguration(directory);
            context = await prepareIdentity(context, options);
            context = await verifyIdentityAndBot(context, options.mode);
            emit({ status: "identity_ready", userId: context.config.user_id, botId: context.config.bot_id });
            context = await reuseSavedRuntime(context, runtimeCandidate, options.mode, cwd);
            context = await prepareRuntimePairing(context);
            context = await startRuntime(context, await runtimeArguments(context, cwd), cwd);
            await waitForRuntime(context, options.harness);
            context = await bindAgent(context, options.harness);
            await finishSetup(context, options);
        } finally {
            await rm(lock, { recursive: true, force: true });
        }
    }

    try {
        await main();
        return 0;
    } catch (cause) {
        emit({
            error: {
                code: host.signal.aborted
                    ? "CANCELLED"
                    : signal.aborted
                      ? "SETUP_TIMEOUT"
                      : typeof errorCode(cause) === "string"
                        ? errorCode(cause)
                        : cause instanceof Error && cause.name === "TimeoutError"
                          ? "TIMEOUT"
                          : "SETUP_FAILED",
                cause: serializeErrorCause(cause),
            },
        });
        return 1;
    }
}
