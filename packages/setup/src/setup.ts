import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { validateLocalPath } from "@moxt-ai/mobius/filesystem";
import { executableLaunch, findExecutableOnPath, stopProcessTree } from "@moxt-ai/mobius/process";
import { decodeIdentifier } from "@moxt-ai/mobius-sdk/protocol";
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
        /** A signal that aborts once the duration elapses. */
        readonly deadline?: (milliseconds: number) => AbortSignal;
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

interface Options {
    readonly base: string;
    readonly cwd: string;
    readonly harness: string;
    readonly sessionId: string;
}

function errorCode(cause: unknown): unknown {
    return cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined;
}

type RuntimeTermination =
    | { readonly kind: "exit"; readonly exitCode: number }
    | { readonly kind: "signal"; readonly signal: string }
    | { readonly kind: "spawn"; readonly code: string };

class RuntimeStartError extends Error {
    readonly code = "RUNTIME_START_FAILED";
    readonly termination: RuntimeTermination;
    readonly logPath: string;
    readonly nextStep =
        "Inspect the Runtime log, then run mobius start --connection <connectionId> for the managed connection and rerun setup. Check mobius --version when diagnosing compatibility; setup does not stop an existing daemon.";

    constructor(termination: RuntimeTermination, logPath: string, cause?: unknown) {
        let reason: string;
        switch (termination.kind) {
            case "exit":
                reason = `exited with code ${termination.exitCode}`;
                break;
            case "signal":
                reason = `was terminated by ${termination.signal}`;
                break;
            case "spawn":
                reason = `could not launch (${termination.code})`;
                break;
            default: {
                const exhaustive: never = termination;
                throw exhaustive;
            }
        }
        super(`The local Runtime command ${reason}. See ${logPath}.`, { cause });
        this.name = "RuntimeStartError";
        this.termination = termination;
        this.logPath = logPath;
    }

    readonly diagnostic = () => ({ termination: this.termination, logPath: this.logPath, nextStep: this.nextStep });
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

// A real upgrade (npm install plus the release switch) took about 100 seconds on
// a typical machine; the rest of setup takes well under the remaining 120 seconds
// of its 300 second budget.
const RUNTIME_UPGRADE_BUDGET_MILLISECONDS = 180_000;

export async function runSetup(args: readonly string[], host: SetupHost): Promise<number> {
    const signal = AbortSignal.any([host.signal, AbortSignal.timeout(300000)]);
    const clock = host.clock ?? {
        now: () => new Date(),
        wait: async (milliseconds: number, parent: AbortSignal) => {
            await delay(milliseconds, undefined, { signal: parent });
        },
    };
    const deadline = host.clock?.deadline ?? ((milliseconds: number) => AbortSignal.timeout(milliseconds));
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

    async function safeLocalPath(path: string, directory: boolean, privateAccess: boolean) {
        try {
            await validateLocalPath(path, directory, privateAccess, signal);
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
        const requested = text(documents);
        if (!isAbsolute(requested)) {
            fail("DOCUMENT_DIR_REQUIRED");
        }
        const normalized = resolve(requested);
        let resolvedDocuments: string;
        try {
            await safeLocalPath(normalized, true, false);
            resolvedDocuments = await realpath(normalized);
        } catch (cause) {
            if (errorCode(cause) !== "ENOENT") {
                throw cause;
            }
            const requestedParent = dirname(normalized);
            await safeLocalPath(requestedParent, true, false);
            const resolvedParent = await realpath(requestedParent);
            await safeLocalPath(resolvedParent, true, false);
            const creatable = join(resolvedParent, basename(normalized));
            signal.throwIfAborted();
            try {
                await mkdir(creatable, { mode: 0o700 });
            } catch (createCause) {
                if (errorCode(createCause) !== "EEXIST") {
                    throw createCause;
                }
            }
            signal.throwIfAborted();
            await safeLocalPath(creatable, true, false);
            resolvedDocuments = await realpath(creatable);
        }
        await safeLocalPath(resolvedDocuments, true, false);
        const directory = join(resolvedDocuments, "morty");
        await mkdir(directory, { mode: 0o700, recursive: true });
        await safeLocalPath(directory, true, true);
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

    async function readPrivateJson(path: string) {
        await safeLocalPath(path, false, true);
        return object(JSON.parse(await readFile(path, "utf8")));
    }

    async function writePrivateFile(path: string, value: string | Uint8Array) {
        const file = await open(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        try {
            await safeLocalPath(path, false, true);
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
            config["base_url"] !== undefined && config["base_url"] !== base
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
            headers["authorization"] = `Bearer ${credential(context.config["user_token"])}`;
        }
        const path =
            authenticated && !route.startsWith("/chat/projects/")
                ? `/projects/${identifier(context.config["project_id"])}${route}`
                : route;
        const response = await fetch(new URL(`/morty/api${path}`, context.base), {
            method: body === undefined ? "GET" : "POST",
            headers,
            redirect: "error",
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
        });
        const value = object(await response.json());
        if (!response.ok) {
            const failure = object(value["error"]);
            const code = text(failure["code"], /^[A-Za-z0-9_-]+$/u);
            const message =
                typeof failure["message"] === "string"
                    ? failure["message"]
                    : `Request failed with HTTP ${response.status}`;
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
        if (positionals.length !== 1 || positionals[0] !== "setup") {
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
        if (values.token !== undefined) {
            fail("INVALID_ARGUMENTS");
        }
        if (values["session-id"] === undefined) {
            fail("SESSION_ID_REQUIRED");
        }
        return { base, cwd, harness, sessionId: identifier(values["session-id"]) };
    }

    async function prepareIdentity(context: Context): Promise<SetupIdentity> {
        if (context.config["user_token"] !== undefined) {
            progress("identity", "Reusing the saved identity.");
            return { kind: "setup", context };
        }
        progress("identity", "Creating the standalone identity and Machine.");
        const identity = await request(context, "/identity/anonymous-users", {}, false);
        const saved = await saveConfiguration(context, {
            user_token: credential(identity["token"]),
            user_id: identifier(identity["userId"]),
            bot_id: identifier(object(identity["bot"])["botId"]),
            project_id: identifier(identity["projectId"]),
            entry: "setup",
        });
        return { kind: "setup", context: saved };
    }

    async function verifyIdentityAndBot(context: Context): Promise<VerifiedIdentity> {
        const session = await request(context, "/session");
        identifier(session["userId"]);
        const listed = await request(context, "/management/bots");
        if (!Array.isArray(listed["bots"])) {
            fail("INVALID_RESPONSE");
        }
        const bot = listed["bots"]
            .map(object)
            .find((item) => context.config["bot_id"] === undefined || item["botId"] === context.config["bot_id"]);
        if (bot === undefined) {
            fail("BOT_NOT_FOUND");
        }
        const botId = identifier(bot["botId"]);
        const detail = await request(context, `/management/bots/${encodeURIComponent(botId)}/runtime-binding`);
        if (identifier(detail["botId"]) !== botId) {
            fail("INVALID_RESPONSE");
        }
        const expectedRuntimeId = detail["runtimeId"] === null ? null : identifier(detail["runtimeId"]);
        return {
            context: await saveConfiguration(context, { user_id: session["userId"], bot_id: botId }),
            expectedRuntimeId,
        };
    }

    /**
     * `stop` says how to end a command that is still running when its operation ends.
     * "command" stops only the CLI: start and pair commands launch the daemon, which
     * outlives them and must keep running. "process-tree" also stops the processes the
     * command started, such as npm, for commands that never launch the daemon.
     */
    async function runMobius(
        context: Context,
        args: readonly string[],
        cwd: string,
        operation = signal,
        stop: "command" | "process-tree" = "command",
    ) {
        operation.throwIfAborted();
        if (host.runtime !== undefined) {
            return await host.runtime.run(context.directory, args, cwd, operation);
        }
        const logPath = join(context.directory, `runtime-${crypto.randomUUID()}.log`);
        const log = await open(
            logPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        let child: ChildProcess | undefined;
        try {
            await safeLocalPath(logPath, false, true);
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
            await once(child, "spawn", { signal: AbortSignal.any([operation, AbortSignal.timeout(10000)]) });
            if (child.pid === undefined || !Number.isSafeInteger(child.pid) || child.pid < 2) {
                fail("RUNTIME_START_FAILED");
            }
            const [code, exitSignal] = await once(child, "exit", { signal: operation });
            if (typeof exitSignal === "string") {
                throw new RuntimeStartError({ kind: "signal", signal: exitSignal }, logPath);
            }
            if (typeof code !== "number") {
                fail("INVALID_RUNTIME_EXIT");
            }
            if (code !== 0) {
                throw new RuntimeStartError({ kind: "exit", exitCode: code }, logPath);
            }
            return { pid: child.pid, logPath };
        } catch (cause) {
            // Only terminate the child this invocation still owns; an exited PID may be reused.
            if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
                try {
                    if (stop === "process-tree") {
                        // Stops the command and its descendants gracefully, then forcibly, on every platform.
                        await stopProcessTree(child);
                    } else {
                        // Ask the CLI to stop first so it can stop what it started, then force it.
                        for (const termination of ["SIGTERM", "SIGKILL"] as const) {
                            if (child.exitCode !== null || child.signalCode !== null) {
                                break;
                            }
                            const exited = once(child, "exit", { signal: AbortSignal.timeout(10000) });
                            child.kill(termination);
                            await exited;
                        }
                    }
                } catch {
                    // Cleanup must not replace the launch failure or prevent its diagnostic from being written.
                }
            }
            operation.throwIfAborted();
            if (errorCode(cause) === "RUNTIME_NOT_INSTALLED") {
                throw cause;
            }
            const code = errorCode(cause);
            const failure =
                cause instanceof RuntimeStartError
                    ? cause
                    : new RuntimeStartError(
                          { kind: "spawn", code: typeof code === "string" ? code : "UNKNOWN" },
                          logPath,
                          cause,
                      );
            // A silent crash still leaves a useful private log without recording pairing credentials.
            await log.writeFile(`${JSON.stringify(failure.diagnostic())}\n`);
            throw failure;
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
                    appId: identifier(connection["app_id"]),
                    connectionId: identifier(connection["connection_id"]),
                    runtimeId: identifier(connection["runtime_id"]),
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
            appId: identifier(pairing["appId"]),
            channelId: identifier(pairing["channelId"]),
            pairingCode: text(pairing["pairingCode"], /^[A-Za-z0-9-]+$/u),
            pairingId: identifier(pairing["pairingId"]),
            projectId: identifier(pairing["projectId"]),
            relayUrl: origin(pairing["relayUrl"]),
            runtimeId: identifier(pairing["runtimeId"]),
        };
        if (selection.appId !== appId || selection.projectId !== context.config["project_id"]) {
            fail("PROJECT_CONFLICT");
        }
        emit({ status: "prepared", botId: context.config["bot_id"] });
        return selection;
    }

    async function replaceProject(context: Context): Promise<Context> {
        progress("identity", "Replacing the Project to pair a new Runtime for the same user.");
        const replacement = await request(context, "/management/project/replacement", {});
        const saved = await saveConfiguration(context, {
            user_token: credential(replacement["token"]),
            user_id: identifier(replacement["userId"]),
            bot_id: identifier(object(replacement["bot"])["botId"]),
            project_id: identifier(replacement["projectId"]),
            // The replacement Machine starts unbound; drop the previous Machine's Agent binding.
            agent_ref: undefined,
            agent_config_revision: undefined,
            entry: "setup",
        });
        emit({ status: "project_replaced", botId: saved.config["bot_id"], projectId: saved.config["project_id"] });
        return saved;
    }

    async function prepareRuntime(
        context: Context,
        cwd: string,
        expectedRuntimeId: string | null,
    ): Promise<{ readonly context: Context; readonly runtime: RuntimeSelection }> {
        progress("pairing", "Preparing the Runtime connection.");
        const project = await request(context, "/management/project");
        const appId = identifier(project["appId"]);
        if (expectedRuntimeId !== null) {
            const existing = (await listManagedConnections(context, cwd)).find(
                (connection) => connection.appId === appId && connection.runtimeId === expectedRuntimeId,
            );
            if (existing !== undefined) {
                emit({
                    status: "runtime_reused",
                    runtimeId: existing.runtimeId,
                    connectionId: existing.connectionId,
                });
                return { context, runtime: { kind: "existing", ...existing } };
            }
            // The saved Machine's Runtime is not managed here anymore: keep the user, but
            // continue on a fresh Project with a fresh Machine and a new Runtime pairing.
            const replaced = await replaceProject(context);
            return { context: replaced, runtime: await createRuntimePairing(replaced, appId) };
        }
        return { context, runtime: await createRuntimePairing(context, appId) };
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

    /**
     * A daemon keeps running the release that started it after the CLI updates,
     * and a release whose own upgrade check fails stays on that release. The
     * installed CLI owns the upgrade path, so once the Runtime is online, bring
     * its daemon to the newest release before setup binds it. The upgrade only refines
     * the Runtime: when it is unavailable, setup continues with the running
     * daemon and reports why.
     */
    async function upgradeRuntime(context: Context, cwd: string): Promise<boolean> {
        // The upgrade has its own budget so a slow download leaves setup time to reuse the running daemon.
        const budget = deadline(RUNTIME_UPGRADE_BUDGET_MILLISECONDS);
        try {
            // The daemon is already running here, so the upgrade command never launches it and
            // stopping the command's process tree cannot stop the daemon.
            await runMobius(context, ["upgrade"], cwd, AbortSignal.any([signal, budget]), "process-tree");
            emit({ status: "runtime_upgrade_checked" });
            return true;
        } catch (cause) {
            signal.throwIfAborted();
            emit({
                status: "runtime_upgrade_skipped",
                error: {
                    code: budget.aborted ? "RUNTIME_UPGRADE_TIMEOUT" : "RUNTIME_UPGRADE_FAILED",
                    cause: serializeErrorCause(cause),
                },
                message: "Continuing with the running Mobius daemon. Run mobius upgrade to update it.",
            });
            return false;
        }
    }

    async function startRuntime(
        context: Context,
        runtime: RuntimeSelection,
        cwd: string,
        harness: string,
    ): Promise<Context> {
        const reuseOnline = async () => {
            if (runtime.kind !== "existing" || !(await runtimeIsOnline(context, runtime, harness))) {
                return false;
            }
            emit({ status: "runtime_already_online", runtimeId: runtime.runtimeId, harness });
            return true;
        };
        // Starting a saved connection is idempotent. Redeeming a one-time pairing is not.
        const maximumAttempts = runtime.kind === "existing" ? 3 : 1;
        for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
            signal.throwIfAborted();
            if (await reuseOnline()) {
                return await saveConfiguration(context, { workspace: cwd });
            }
            try {
                const started = await runMobius(context, runtimeArguments(runtime, cwd), cwd);
                emit({ status: "runtime_started", ...started });
                return await saveConfiguration(context, { workspace: cwd });
            } catch (cause) {
                signal.throwIfAborted();
                if (!(cause instanceof RuntimeStartError)) {
                    throw cause;
                }
                // A launcher may fail after the daemon has connected successfully.
                if (await reuseOnline()) {
                    return await saveConfiguration(context, { workspace: cwd });
                }
                if (attempt === maximumAttempts) {
                    throw cause;
                }
                emit({
                    status: "runtime_retrying",
                    attempt: attempt + 1,
                    maximumAttempts,
                    failure: cause.diagnostic(),
                });
                await clock.wait(1000, signal);
            }
        }
        fail("RUNTIME_START_FAILED");
    }

    function hasOnlineRuntimeAgent(runtime: Record<string, unknown>, runtimeId: string, agentRef: string): boolean {
        return (
            runtime["runtimeId"] === runtimeId &&
            runtime["online"] === true &&
            Array.isArray(runtime["agents"]) &&
            runtime["agents"].some((agent) => object(agent)["agentRef"] === agentRef)
        );
    }

    function setupHasOnlineRuntimeAgent(setup: Record<string, unknown>, runtimeId: string, agentRef: string): boolean {
        return (
            Array.isArray(setup["runtimes"]) &&
            setup["runtimes"].some((runtime) => hasOnlineRuntimeAgent(object(runtime), runtimeId, agentRef))
        );
    }

    async function runtimeIsOnline(context: Context, runtime: RuntimeSelection, harness: string): Promise<boolean> {
        const botPath = `/chat/projects/${context.config["project_id"]}/bots/${context.config["bot_id"]}`;
        const alreadyConfigured = runtime.kind === "existing" && typeof context.config["agent_ref"] === "string";
        const state = await request(context, `${botPath}/${alreadyConfigured ? "workspace" : "setup/runtimes"}`, {});
        return alreadyConfigured
            ? hasOnlineRuntimeAgent(object(state["runtime"]), runtime.runtimeId, harness)
            : setupHasOnlineRuntimeAgent(state, runtime.runtimeId, harness);
    }

    async function waitForRuntime(context: Context, runtime: RuntimeSelection, harness: string) {
        const runtimeId = runtime.runtimeId;
        let attempts = 0;
        if (runtime.kind === "pairing") {
            while (true) {
                signal.throwIfAborted();
                const status = await request(context, `/management/runtime-pairings/${runtime.pairingId}`);
                if (status["status"] !== "pending" && status["status"] !== "paired") {
                    fail("RUNTIME_PAIRING_UNAVAILABLE");
                }
                if (attempts++ % 10 === 0) {
                    progress("runtime", "Waiting for Runtime pairing to complete.");
                }
                if (status["status"] === "paired") {
                    if (status["runtimeId"] !== runtimeId || !Array.isArray(status["agents"])) {
                        fail("INVALID_RESPONSE");
                    }
                    if (status["agents"].some((agent) => object(agent)["id"] === harness)) {
                        emit({ status: "runtime_paired", runtimeId, harness });
                        break;
                    }
                    emit({
                        status: "harness_unavailable",
                        harness,
                        available: status["agents"].map((agent) => identifier(object(agent)["id"])),
                    });
                    fail("HARNESS_UNAVAILABLE");
                }
                await clock.wait(1000, signal);
            }
        }

        attempts = 0;
        while (true) {
            signal.throwIfAborted();
            const online = await runtimeIsOnline(context, runtime, harness);
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
        const revision = context.config["agent_ref"] === agentRef ? (context.config["agent_config_revision"] ?? 1) : 1;
        if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
            fail("AGENT_REVISION_REQUIRED");
        }
        await request(
            context,
            `/chat/projects/${context.config["project_id"]}/bots/${context.config["bot_id"]}/setup`,
            {
                runtimeId,
                agentRef,
            },
        );
        const saved = await saveConfiguration(context, { agent_ref: agentRef, agent_config_revision: revision });
        emit({ status: "binding_activated", botId: context.config["bot_id"], harness });
        return saved;
    }

    function hasReadyBinding(context: Context, runtime: RuntimeSelection, configuration: Record<string, unknown>) {
        const runtimeId = runtime.runtimeId;
        if (
            typeof context.config["agent_ref"] !== "string" ||
            !hasOnlineRuntimeAgent(object(configuration["runtime"]), runtimeId, context.config["agent_ref"])
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
                `/chat/projects/${context.config["project_id"]}/bots/${context.config["bot_id"]}/workspace`,
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
        if (decoded === null || object(decoded)["data"] !== value) {
            fail("QR_VERIFICATION_FAILED");
        }

        const qrPath = join(tmpdir(), `morty-handoff-${crypto.randomUUID()}.png`);
        try {
            await writePrivateFile(qrPath, image);
            await safeLocalPath(qrPath, false, true);
        } catch (cause) {
            await rm(qrPath, { force: true });
            throw cause;
        }

        return qrPath;
    }

    async function finishSetup(context: Context, runtime: RuntimeSelection, options: Options) {
        await waitForReadiness(context, runtime);
        const botId = context.config["bot_id"];
        const workingDirectory = text(context.config["workspace"]);
        const transfer = await request(context, "/identity/transfers", {});
        const url = new URL(text(transfer["url"]));
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
        url.searchParams.set("workspace", workingDirectory);
        const handoffUrl = url.toString();
        // QR is an auxiliary representation: its capacity and decoding limits must
        // not prevent delivery of an otherwise valid handoff link.
        const qr = await (async (): Promise<
            | { readonly kind: "available"; readonly path: string }
            | { readonly kind: "unavailable"; readonly cause: ErrorCause }
        > => {
            try {
                return { kind: "available", path: await createQrCode(handoffUrl) };
            } catch (cause) {
                signal.throwIfAborted();
                return { kind: "unavailable", cause: serializeErrorCause(cause) };
            }
        })();
        signal.throwIfAborted();
        if (qr.kind === "unavailable") {
            emit({
                status: "qr_unavailable",
                error: { code: "QR_UNAVAILABLE", cause: qr.cause },
                message: "The QR image is unavailable. Use the handoff link instead.",
            });
        }
        emit({
            status: "ready",
            botId,
            url: handoffUrl,
            workspace: workingDirectory,
            qrPath: qr.kind === "available" ? qr.path : null,
            message:
                qr.kind === "available"
                    ? "Open the link or scan the QR code to chat. Keep the Runtime online."
                    : "Open the link to chat. Keep the Runtime online.",
        });
    }

    async function main() {
        const options = readOptions();
        const base = options.base;
        const cwd = await resolveWorkingDirectory(options.cwd);
        const directory = await prepareDirectory(await resolveDocumentsDirectory(host.documents, signal));
        let context: Context = await loadConfiguration(directory, base);
        const identity = await prepareIdentity(context);
        context = identity.context;
        const verified = await verifyIdentityAndBot(context);
        context = verified.context;
        emit({ status: "identity_ready", userId: context.config["user_id"], botId: context.config["bot_id"] });
        const prepared = await prepareRuntime(context, cwd, verified.expectedRuntimeId);
        context = prepared.context;
        context = await startRuntime(context, prepared.runtime, cwd, options.harness);
        await waitForRuntime(context, prepared.runtime, options.harness);
        if (await upgradeRuntime(context, cwd)) {
            // Switching releases reconnects the Runtime.
            await waitForRuntime(context, prepared.runtime, options.harness);
        }
        context = await bindAgent(context, prepared.runtime, options.harness);
        await finishSetup(context, prepared.runtime, options);
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
                ...(cause instanceof RuntimeStartError ? { runtime: cause.diagnostic() } : {}),
            },
        });
        return 1;
    }
}
