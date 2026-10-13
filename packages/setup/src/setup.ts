import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { validateLocalPath } from "@moxt-ai/mobius/filesystem";
import { executableLaunch, findExecutableOnPath } from "@moxt-ai/mobius/process";
import { decodeIdentifier } from "@moxt-ai/mobius-protocol";
import jsQrImport from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import { resolveDocumentsDirectory } from "./platform/index.ts";

export interface SetupRuntime {
    readonly run: (
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

type RuntimeSelection =
    | {
          readonly kind: "existing";
          readonly appId: string;
          readonly connectionId: string;
          readonly runtimeId: string;
      }
    | {
          readonly kind: "pairing";
          readonly appId: string;
          readonly channelId: string;
          readonly pairingCode: string;
          readonly pairingId: string;
          readonly projectId: string;
          readonly relayUrl: string;
          readonly runtimeId: string;
      };

interface ManagedConnection {
    readonly appId: string;
    readonly connectionId: string;
    readonly runtimeId: string;
}

interface VerifiedIdentity {
    readonly context: Context;
    readonly expectedRuntimeId: string | null;
}

interface SetupIdentity {
    readonly kind: "setup";
    readonly context: Context;
}

interface PairIdentity {
    readonly kind: "pair";
    readonly context: Context;
    readonly expectedRuntimeId: string | null;
}

type PreparedIdentity = SetupIdentity | PairIdentity;

type HarnessReadinessWait = { readonly kind: "pairing" } | { readonly kind: "installing"; readonly deadline: number };

const HARNESS_INSTALL_TIMEOUT_MILLISECONDS = 60_000;

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

    const identifier = (value: unknown) => {
        try {
            return decodeIdentifier(value);
        } catch {
            return fail("INVALID_RESPONSE");
        }
    };
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
        try {
            await validateLocalPath(path, directory, true, signal);
        } catch (cause) {
            if (signal.aborted) {
                signal.throwIfAborted();
            }
            if (errorCode(cause) === "ENOENT") {
                throw cause;
            }
            fail("UNSAFE_CONFIG_PATH", cause instanceof Error ? cause : undefined);
        }
    }

    async function prepareDirectory(documents: string) {
        if (!isAbsolute(text(documents))) {
            fail("DOCUMENT_DIR_REQUIRED");
        }
        const directory = join(await realpath(documents), "morty");
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
            await validateLocalPath(resolved, true, false, signal);
            return resolved;
        } catch (cause) {
            if (signal.aborted) {
                signal.throwIfAborted();
            }
            if (errorCode(cause) === "UNSAFE_WORKING_DIRECTORY") {
                throw cause;
            }
            fail(errorCode(cause) === "ENOENT" ? "WORKING_DIRECTORY_UNAVAILABLE" : "UNSAFE_WORKING_DIRECTORY");
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
            await privatePath(path, false);
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
        // Preserve identity and Bot configuration; resolve Runtime connections through the manager.
        const identity =
            config.base_url !== undefined && config.base_url !== base
                ? {}
                : Object.fromEntries(
                      Object.entries(config).filter(([key]) =>
                          [
                              "user_token",
                              "user_id",
                              "project_id",
                              "bot_id",
                              "agent_ref",
                              "agent_config_revision",
                          ].includes(key),
                      ),
                  );
        return { directory, base, config: identity };
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
        const response = await fetch(new URL(`/morty/api${path}`, context.base), {
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

    async function preparePairIdentity(context: Context, ticket: string): Promise<PairIdentity> {
        progress("identity", "Exchanging the one-time ticket for the existing user and Machine.");
        const identity = await request(context, "/identity/pairings/redeem", { token: ticket }, false);
        const expectedRuntimeId = identity.expectedRuntimeId === null ? null : identifier(identity.expectedRuntimeId);
        const saved = await saveConfiguration(context, {
            user_token: credential(identity.token),
            user_id: identifier(identity.userId),
            bot_id: identifier(identity.botId),
            project_id: identifier(identity.projectId),
            entry: "pair",
        });
        return { kind: "pair", context: saved, expectedRuntimeId };
    }

    async function prepareIdentity(context: Context, options: Options): Promise<PreparedIdentity> {
        if (options.mode === "pair") {
            return await preparePairIdentity(context, options.token);
        }
        if (context.config.user_token !== undefined) {
            progress("identity", "Reusing the saved identity.");
            return { kind: "setup", context };
        }
        progress("identity", "Creating the standalone identity and Machine.");
        const identity = await request(context, "/identity/anonymous-users", {}, false);
        const saved = await saveConfiguration(context, {
            user_token: credential(identity.token),
            user_id: identifier(identity.userId),
            bot_id: identifier(object(identity.bot).botId),
            project_id: identifier(identity.projectId),
            entry: "setup",
        });
        return { kind: "setup", context: saved };
    }

    async function verifyIdentityAndBot(context: Context, mode: Options["mode"]): Promise<VerifiedIdentity> {
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
        const botId = identifier(bot.botId);
        const detail = await request(context, `/management/bots/${encodeURIComponent(botId)}/runtime-binding`);
        if (identifier(detail.botId) !== botId) {
            fail("INVALID_RESPONSE");
        }
        const expectedRuntimeId = detail.runtimeId === null ? null : identifier(detail.runtimeId);
        return {
            context: await saveConfiguration(context, { user_id: session.userId, bot_id: botId }),
            expectedRuntimeId,
        };
    }

    async function runMobius(context: Context, args: readonly string[], cwd: string) {
        signal.throwIfAborted();
        if (host.runtime !== undefined) {
            return await host.runtime.run(context.directory, args, cwd, signal);
        }
        const logPath = join(context.directory, `runtime-${crypto.randomUUID()}.log`);
        const log = await open(
            logPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        let child: ChildProcess | undefined;
        try {
            await privatePath(logPath, false);
            const executable = await findExecutableOnPath("mobius", process.env);
            if (executable === null) {
                fail("RUNTIME_NOT_INSTALLED");
            }
            const launch = executableLaunch(executable.path, args);
            child = spawn(launch.command, [...launch.arguments], {
                cwd,
                stdio: ["ignore", log.fd, log.fd],
                windowsHide: true,
            });
            await once(child, "spawn", { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
            if (child.pid === undefined || !Number.isSafeInteger(child.pid) || child.pid < 2) {
                fail("RUNTIME_START_FAILED");
            }
            const [code] = await once(child, "exit", { signal });
            if (code !== 0) {
                fail("RUNTIME_START_FAILED");
            }
            return { pid: child.pid, logPath };
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

    async function listManagedConnections(context: Context, cwd: string): Promise<readonly ManagedConnection[]> {
        const outputPath = join(tmpdir(), `mobius-pair-list-${crypto.randomUUID()}.json`);
        await writePrivateFile(outputPath, "");
        try {
            await runMobius(context, ["pair", "list", `--output-json=${outputPath}`], cwd);
            const value: unknown = JSON.parse(await readFile(outputPath, "utf8"));
            if (!Array.isArray(value)) {
                fail("INVALID_PAIR_LIST");
            }
            return value.map((item) => {
                const connection = object(item);
                return {
                    appId: identifier(connection.app_id),
                    connectionId: identifier(connection.connection_id),
                    runtimeId: identifier(connection.runtime_id),
                };
            });
        } finally {
            await rm(outputPath, { force: true });
        }
    }

    async function createRuntimePairing(context: Context, appId: string): Promise<RuntimeSelection> {
        const pairing = await request(context, "/management/runtime-pairings", {
            idempotencyKey: crypto.randomUUID(),
        });
        const selection: RuntimeSelection = {
            kind: "pairing",
            appId: identifier(pairing.appId),
            channelId: identifier(pairing.channelId),
            pairingCode: text(pairing.pairingCode, /^[A-Za-z0-9-]+$/u),
            pairingId: identifier(pairing.pairingId),
            projectId: identifier(pairing.projectId),
            relayUrl: origin(pairing.relayUrl),
            runtimeId: identifier(pairing.runtimeId),
        };
        if (selection.appId !== appId || selection.projectId !== context.config.project_id) {
            fail("PROJECT_CONFLICT");
        }
        emit({ status: "prepared", botId: context.config.bot_id });
        return selection;
    }

    async function prepareRuntime(
        context: Context,
        cwd: string,
        mode: Options["mode"],
        expectedRuntimeId: string | null,
    ): Promise<RuntimeSelection> {
        progress("pairing", "Preparing the Runtime connection.");
        const project = await request(context, "/management/project");
        const appId = identifier(project.appId);
        if (mode === "pair") {
            return await createRuntimePairing(context, appId);
        }
        if (expectedRuntimeId !== null) {
            const existing = (await listManagedConnections(context, cwd)).find(
                (connection) => connection.appId === appId && connection.runtimeId === expectedRuntimeId,
            );
            if (existing === undefined) {
                fail("RUNTIME_CONNECTION_UNAVAILABLE");
            }
            emit({
                status: "runtime_reused",
                runtimeId: existing.runtimeId,
                connectionId: existing.connectionId,
            });
            return { kind: "existing", ...existing };
        }
        return await createRuntimePairing(context, appId);
    }

    function runtimeArguments(runtime: RuntimeSelection, cwd: string): readonly string[] {
        if (runtime.kind === "existing") {
            return ["start", "--connection", runtime.connectionId];
        }
        return [
            "pair",
            "--url",
            runtime.relayUrl,
            "--pairing",
            runtime.pairingId,
            "--code",
            runtime.pairingCode,
            "--workspace",
            cwd,
        ];
    }

    function validateExpectedRuntime(identity: PreparedIdentity, runtime: RuntimeSelection): void {
        switch (identity.kind) {
            case "setup":
                return;
            case "pair":
                if (identity.expectedRuntimeId !== null && identity.expectedRuntimeId !== runtime.runtimeId) {
                    fail("RUNTIME_MISMATCH");
                }
                return;
        }
    }

    async function startRuntime(context: Context, runtime: RuntimeSelection, cwd: string): Promise<Context> {
        const started = await runMobius(context, runtimeArguments(runtime, cwd), cwd);
        emit({ status: "runtime_started", ...started });
        return await saveConfiguration(context, { workspace: cwd });
    }

    function hasOnlineRuntimeAgent(runtime: Record<string, unknown>, runtimeId: string, agentRef: string): boolean {
        return (
            runtime.runtimeId === runtimeId &&
            runtime.online === true &&
            Array.isArray(runtime.agents) &&
            runtime.agents.some((agent) => object(agent).agentRef === agentRef)
        );
    }

    function setupHasOnlineRuntimeAgent(setup: Record<string, unknown>, runtimeId: string, agentRef: string): boolean {
        return (
            Array.isArray(setup.runtimes) &&
            setup.runtimes.some((runtime) => hasOnlineRuntimeAgent(object(runtime), runtimeId, agentRef))
        );
    }

    async function waitForRuntime(context: Context, runtime: RuntimeSelection, harness: string) {
        const runtimeId = runtime.runtimeId;
        let attempts = 0;
        if (runtime.kind === "pairing") {
            let readiness: HarnessReadinessWait = { kind: "pairing" };
            while (true) {
                signal.throwIfAborted();
                const status = await request(context, `/management/runtime-pairings/${runtime.pairingId}`);
                if (status.status !== "pending" && status.status !== "paired") {
                    fail("RUNTIME_PAIRING_UNAVAILABLE");
                }
                if (attempts++ % 10 === 0) {
                    progress("runtime", "Waiting for Runtime pairing to complete.");
                }
                if (status.status === "paired") {
                    if (
                        status.runtimeId !== runtimeId ||
                        !Array.isArray(status.agents) ||
                        !Array.isArray(status.installableAgents)
                    ) {
                        fail("INVALID_RESPONSE");
                    }
                    if (status.agents.some((agent) => object(agent).id === harness)) {
                        emit({ status: "runtime_paired", runtimeId, harness });
                        break;
                    }
                    if (!status.installableAgents.some((agent) => object(agent).id === harness)) {
                        emit({
                            status: "harness_unavailable",
                            harness,
                            available: status.agents.map((agent) => identifier(object(agent).id)),
                        });
                        fail("HARNESS_UNAVAILABLE");
                    }
                    if (readiness.kind === "pairing") {
                        readiness = {
                            kind: "installing",
                            deadline: clock.now().getTime() + HARNESS_INSTALL_TIMEOUT_MILLISECONDS,
                        };
                        progress("runtime", `Waiting for ${harness} to finish installing.`);
                    } else if (clock.now().getTime() >= readiness.deadline) {
                        fail("HARNESS_INSTALL_TIMEOUT");
                    }
                }
                await clock.wait(1000, signal);
            }
        }

        attempts = 0;
        while (true) {
            signal.throwIfAborted();
            const botPath = `/chat/projects/${context.config.project_id}/bots/${context.config.bot_id}`;
            const alreadyConfigured = runtime.kind === "existing" && typeof context.config.agent_ref === "string";
            const state = await request(
                context,
                `${botPath}/${alreadyConfigured ? "workspace" : "setup/runtimes"}`,
                {},
            );
            const online = alreadyConfigured
                ? hasOnlineRuntimeAgent(object(state.runtime), runtimeId, harness)
                : setupHasOnlineRuntimeAgent(state, runtimeId, harness);
            if (online) {
                if (runtime.kind === "existing") {
                    emit({ status: "runtime_paired", runtimeId, harness });
                }
                emit({ status: "runtime_online", runtimeId, harness });
                return;
            }
            if (attempts++ % 10 === 0) {
                progress("runtime", `Waiting for the Runtime and ${harness} to come online.`);
            }
            await clock.wait(1000, signal);
        }
    }

    async function bindAgent(context: Context, runtime: RuntimeSelection, harness: string) {
        progress("binding", `Connecting the Machine to ${harness} in the default working directory.`);
        const runtimeId = runtime.runtimeId;
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

    function hasReadyBinding(context: Context, runtime: RuntimeSelection, configuration: Record<string, unknown>) {
        const runtimeId = runtime.runtimeId;
        if (
            typeof context.config.agent_ref !== "string" ||
            !hasOnlineRuntimeAgent(object(configuration.runtime), runtimeId, context.config.agent_ref)
        ) {
            return false;
        }
        return true;
    }

    async function waitForReadiness(context: Context, runtime: RuntimeSelection) {
        let attempts = 0;
        while (true) {
            signal.throwIfAborted();
            const configuration = await request(
                context,
                `/chat/projects/${context.config.project_id}/bots/${context.config.bot_id}/workspace`,
                {},
            );
            if (hasReadyBinding(context, runtime, configuration)) {
                return;
            }
            if (attempts++ % 10 === 0) {
                progress("activation", "Waiting for the Machine binding to become active.");
            }
            await clock.wait(1000, signal);
        }
    }

    async function createQrCode(value: string) {
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

        const qrPath = join(tmpdir(), `morty-handoff-${crypto.randomUUID()}.png`);
        try {
            await writePrivateFile(qrPath, image);
            await privatePath(qrPath, false);
        } catch (cause) {
            await rm(qrPath, { force: true });
            throw cause;
        }

        return qrPath;
    }

    async function finishSetup(context: Context, runtime: RuntimeSelection, options: Options) {
        await waitForReadiness(context, runtime);
        const botId = context.config.bot_id;
        const workingDirectory = text(context.config.workspace);
        if (options.mode === "pair") {
            emit({
                status: "ready",
                botId,
                url: context.base,
                workspace: workingDirectory,
                message: "Return to your Morty page to start chatting. Keep the Runtime online.",
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
        const qrPath = await createQrCode(handoffUrl);
        emit({
            status: "ready",
            botId,
            url: handoffUrl,
            workspace: workingDirectory,
            qrPath,
            message: "Open the link or scan the QR code to chat. Keep the Runtime online.",
        });
    }

    async function main() {
        const options = readOptions();
        const base = options.base;
        const cwd = await resolveWorkingDirectory(options.cwd);
        const directory = await prepareDirectory(await resolveDocumentsDirectory(host.documents, signal));
        const lock = await acquireLock(directory);
        try {
            let context: Context =
                options.mode === "setup" ? await loadConfiguration(directory, base) : { directory, base, config: {} };
            const identity = await prepareIdentity(context, options);
            context = identity.context;
            const verified = await verifyIdentityAndBot(context, options.mode);
            context = verified.context;
            emit({ status: "identity_ready", userId: context.config.user_id, botId: context.config.bot_id });
            const runtime = await prepareRuntime(context, cwd, options.mode, verified.expectedRuntimeId);
            validateExpectedRuntime(identity, runtime);
            context = await startRuntime(context, runtime, cwd);
            await waitForRuntime(context, runtime, options.harness);
            context = await bindAgent(context, runtime, options.harness);
            await finishSetup(context, runtime, options);
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
