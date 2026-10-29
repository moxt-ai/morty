import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { decodeIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import jsQrImport from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import { validateLocalPath } from "../../../third-party/mobius/packages/cli/src/engine/util/filesystem/private-path.ts";
import {
    executableLaunch,
    findExecutableOnPath,
    runBoundedProcess,
    stopProcessTree,
} from "../../../third-party/mobius/packages/cli/src/engine/util/process/executable.ts";
import { resolveDocumentsDirectory, resolveStateDirectory } from "./platform/index.ts";

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
    /**
     * Where this computer keeps Morty's private state. Empty selects the platform's local application data directory,
     * which is not synced to the user's other computers.
     */
    readonly state: string;
    /** The Documents directory earlier releases kept that state in, read once to move it. Empty selects the user's. */
    readonly documents: string;
    readonly signal: AbortSignal;
    readonly emit: (value: Readonly<Record<string, unknown>>) => void;
    /** The calling Agent's environment, where its harness exposes the current session. Defaults to this process's. */
    readonly agentEnvironment?: Readonly<Record<string, string | undefined>>;
    readonly runtime?: SetupRuntime;
    readonly clock?: {
        readonly now: () => Date;
        readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
        /** A signal that aborts once the duration elapses. */
        readonly deadline?: (milliseconds: number) => AbortSignal;
    };
}

/** Where each supported harness exposes its current session to the commands its Agent runs. */
const harnessSessionVariables: ReadonlyMap<string, string> = new Map([
    ["claude", "CLAUDE_CODE_SESSION_ID"],
    ["codex", "CODEX_THREAD_ID"],
    ["pi", "PI_SESSION_ID"],
]);

interface Context {
    readonly directory: string;
    readonly base: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly replacement: ReplacementState;
}

interface RetiringIdentity {
    readonly kind: "pending";
    readonly projectId: string;
    readonly token: string;
}

type ReplacementState =
    | { readonly kind: "unchanged" }
    | { readonly kind: "unknown" }
    | {
          readonly kind: "revoked";
          readonly previous: RetiringIdentity | { readonly kind: "retired"; readonly projectId: string | null };
      }
    // Earlier releases could owe identity cleanup without owing a completion notice.
    | { readonly kind: "retiring"; readonly previous: RetiringIdentity };

type RuntimeSelection =
    | {
          readonly kind: "existing";
          readonly appId: string;
          readonly connectionId: string;
          readonly runtimeId: string;
          /**
           * Whether the Worker binds the Machine to this Runtime. The Worker's binding is the record; the local
           * `agent_ref` only remembers the harness a finished run bound, and a run that stopped after the Worker
           * bound the Machine never wrote it.
           */
          readonly bound: boolean;
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

/**
 * What setup did to this computer's Project. `replaced` ended every link and browser from the previous
 * Project, so the agent must tell the user; the saved replacement keeps that owed until a finished
 * setup reports it, even when the run that replaced the Project stopped first.
 */
type ProjectOutcome = "created" | "reused" | "replaced";

interface SetupIdentity {
    readonly kind: "setup";
    readonly context: Context;
    readonly project: Exclude<ProjectOutcome, "replaced">;
}

interface SetupOptions {
    readonly base: string;
    readonly cwd: string;
    readonly harness: string;
    readonly sessionId: string;
    /** Explicit local approval applies only to this Project, never to a later replacement. */
    readonly replaceProject: string | null;
}

type ReplacementAccess =
    | { readonly kind: "unchanged" }
    | { readonly kind: "unknown"; readonly previousProjectId: string }
    | { readonly kind: "revoked"; readonly previousProjectId: string | null; readonly projectId: string };

type ReplacementReason = "managed_runtime_missing" | "replacement_result_unknown";

class ProjectReplacementRequiredError extends Error {
    readonly code = "PROJECT_REPLACEMENT_REQUIRED";
    readonly projectId: string;
    readonly reason: ReplacementReason;

    constructor(projectId: string, reason: ReplacementReason) {
        super(
            reason === "managed_runtime_missing"
                ? "The saved connection is missing. Replacing it will revoke earlier sharing links and browser access."
                : "An earlier replacement has an unknown result. Continue only with approval for that same Project.",
        );
        this.name = "ProjectReplacementRequiredError";
        this.projectId = projectId;
        this.reason = reason;
    }

    readonly diagnostic = () => ({
        projectId: this.projectId,
        reason: this.reason,
        nextStep:
            "Explain the access impact and ask the user whether to continue, unless they already explicitly approved this same replacement. " +
            `Only after explicit approval, rerun the same setup command with --replace-project ${this.projectId}. ` +
            "Do not remove local state or create another identity to bypass this confirmation.",
    });
}

interface RevokeAllAccessOptions {
    readonly base: string | undefined;
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

class RuntimePreflightError extends Error {
    readonly code = "RUNTIME_PREFLIGHT_FAILED";
    readonly nextStep =
        "Install Node.js 22.19.0 or newer and npm, reinstall the latest @moxt-ai/mobius using that Node.js, then verify mobius --version in the same terminal and rerun setup.";

    constructor(message: string, cause?: unknown) {
        super(message, { cause });
        this.name = "RuntimePreflightError";
    }

    readonly diagnostic = () => ({
        nodeVersion: process.versions.node,
        nodeExecutable: process.execPath,
        ...(this.cause instanceof RuntimeStartError
            ? { logPath: this.cause.logPath, termination: this.cause.termination }
            : {}),
        nextStep: this.nextStep,
    });
}

/** `mobius` exits with EX_CONFIG (78) when MOBIUS_STATE_DIRECTORY names another root's installation data. */
const MOBIUS_EXIT_STATE_ROOT_INVALID = 78;

/** Mobius refused this shell's state root; setup must not continue against a state it cannot see. */
class MobiusStateRootError extends Error {
    readonly code = "MOBIUS_STATE_ROOT_INVALID";
    readonly logPath: string;
    readonly nextStep =
        "This shell's MOBIUS_STATE_DIRECTORY names Mobius installation data that an earlier Mobius Runtime passed to this agent, not a state root. Rerun setup with MOBIUS_STATE_DIRECTORY set to the state root that the Runtime log names.";

    constructor(logPath: string) {
        super(`Mobius refused this shell's state root. See ${logPath}.`);
        this.name = "MobiusStateRootError";
        this.logPath = logPath;
    }

    readonly diagnostic = (access: ReplacementAccess) => ({
        logPath: this.logPath,
        nextStep: `${this.nextStep} ${
            access.kind === "unchanged"
                ? "Setup changed nothing; existing Morty links keep working."
                : "An earlier replacement may already have changed shared access. Report replacementAccess before retrying; do not assume the old links still work."
        }`,
    });
}

/** A failure the Morty service reported with its own error code. */
class RemoteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RemoteError";
    }
}

/** What the agent should do after binding failed, chosen by the failure's code rather than its message. */
function bindingNextStep(code: string, harness: string): string {
    switch (code) {
        case "authentication_required":
            return `Ask the user to sign in to ${harness} on this computer; you cannot sign in for them. When they confirm, rerun setup; it reuses this computer's Machine.`;
        case "TIMEOUT":
        case "PLATFORM_TIMEOUT":
        case "PLATFORM_UNAVAILABLE":
            return `Rerun setup without changing anything; it reuses this computer's Machine. The Morty service or ${harness} may have been briefly unavailable. If it fails the same way again, confirm ${harness} answers a prompt in the working directory.`;
        default:
            return `Confirm ${harness} answers a prompt in the working directory and fix what stops it, then rerun setup; it reuses this computer's Machine. If ${harness} answers and setup fails the same way again, report error.code to the user.`;
    }
}

/** Setup could not bind the Machine to the chosen harness. */
class AgentBindingError extends Error {
    readonly code: string;
    readonly harness: string;
    readonly nextStep: string;

    constructor(code: string, harness: string, cause: unknown) {
        super(`Setup could not connect ${harness} on this computer.`, { cause });
        this.name = "AgentBindingError";
        this.code = code;
        this.harness = harness;
        this.nextStep = bindingNextStep(code, harness);
    }

    readonly diagnostic = () => ({ harness: this.harness, nextStep: this.nextStep });
}

/** Why the local Agent inventory says the chosen harness cannot run, as `mobius agents` reports it. */
interface HarnessDiagnosis {
    readonly status: string;
    readonly label: string;
    readonly recoveryCommand: string;
    readonly minimumSupportedVersion: string;
}

/** What the agent should do when the Runtime does not offer the chosen harness, chosen by the inventory status. */
function harnessNextStep(harness: string, diagnosis: HarnessDiagnosis | null): string {
    const rerun = `rerun setup with --harness ${harness}; it reuses this computer's Machine.`;
    switch (diagnosis?.status) {
        case "authentication_required":
            return `Ask the user to sign in to ${diagnosis.label} on this computer by running \`${diagnosis.recoveryCommand || harness}\` in a terminal; you cannot sign in for them. When they confirm, ${rerun}`;
        case "missing_agent":
            return `Mobius cannot find ${diagnosis.label} on this computer. Make sure \`${harness}\` runs in a new terminal, then ${rerun} Do not switch to another harness.`;
        case "missing_adapter":
            return diagnosis.recoveryCommand.length > 0
                ? `Install the ${diagnosis.label} adapter by running \`${diagnosis.recoveryCommand}\`, then ${rerun}`
                : `Install the ${diagnosis.label} adapter, then ${rerun}`;
        case "unsupported_version":
            return `Update ${diagnosis.label} to ${diagnosis.minimumSupportedVersion || "its latest release"} or newer, then ${rerun}`;
        case "ready":
            // Mobius 0.0.314 and later refresh a running Runtime's Agents when setup starts it; earlier releases keep
            // the Agents they found at startup until the daemon restarts.
            return `${diagnosis.label} is ready, but this computer's running Morty Runtime has not picked it up yet. Rerun setup once. If it fails the same way again, ask the user before running \`mobius quit\`, because it stops every Morty session on this computer; when they agree, run it and ${rerun}`;
        default:
            return `Confirm \`${harness}\` starts and answers a prompt in a new terminal and fix what stops it, then ${rerun} If it answers and setup fails the same way again, report error.code to the user.`;
    }
}

/** The Runtime does not offer the chosen harness. */
class HarnessUnavailableError extends Error {
    readonly code = "HARNESS_UNAVAILABLE";
    readonly harness: string;
    readonly agentStatus: string;
    readonly nextStep: string;

    constructor(harness: string, diagnosis: HarnessDiagnosis | null) {
        super(`The Runtime does not offer ${harness}.`);
        this.name = "HarnessUnavailableError";
        this.harness = harness;
        this.agentStatus = diagnosis?.status ?? "unknown";
        this.nextStep = harnessNextStep(harness, diagnosis);
    }

    readonly diagnostic = () => ({ harness: this.harness, status: this.agentStatus, nextStep: this.nextStep });
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
        .replace(/mobius_anon_v2_[A-Za-z0-9_-]+|mobius_(?:transfer_v2|recovery_v1)\.[A-Za-z0-9._-]+/gu, "[REDACTED]")
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

// A Runtime comes online while it still republishes its harness catalog, so the catalog an existing Runtime shows
// right after it starts may predate an install. A new pairing carries the catalog it was redeemed with instead.
const HARNESS_CATALOG_GRACE_MILLISECONDS = 30_000;

export async function runSetup(args: readonly string[], host: SetupHost): Promise<number> {
    const signal = AbortSignal.any([host.signal, AbortSignal.timeout(300000)]);
    const clock = host.clock ?? {
        now: () => new Date(),
        wait: async (milliseconds: number, parent: AbortSignal) => {
            await delay(milliseconds, undefined, { signal: parent });
        },
    };
    const deadline = host.clock?.deadline ?? ((milliseconds: number) => AbortSignal.timeout(milliseconds));
    const runId = crypto.randomUUID();
    const emit = (value: Readonly<Record<string, unknown>>) =>
        host.emit({ time: clock.now().toISOString(), runId, ...value });
    let replacementAccess: ReplacementAccess = { kind: "unchanged" };
    let setupReady = false;

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

    /** Creates the state directory with private permissions, refusing one that is a link to somewhere else. */
    async function prepareStateDirectory(requested: string) {
        const directory = resolve(requested);
        await mkdir(directory, { mode: 0o700, recursive: true });
        signal.throwIfAborted();
        await safeLocalPath(directory, true, true);
        return directory;
    }

    /** The directory earlier releases kept this state in, under Documents, or null when it does not exist. */
    async function earlierStateDirectory() {
        const documents = resolveDocumentsDirectory(host.documents, signal);
        if (documents === null) {
            return null;
        }
        const directory = join(resolve(documents), "morty");
        try {
            await safeLocalPath(directory, true, false);
        } catch (cause) {
            if (errorCode(cause) === "ENOENT") {
                return null;
            }
            throw cause;
        }
        return directory;
    }

    async function readOptionalPrivateJson(path: string) {
        try {
            return await readPrivateJson(path);
        } catch (cause) {
            if (errorCode(cause) === "ENOENT") {
                return null;
            }
            throw cause;
        }
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

    function savedIdentity(config: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
        return Object.fromEntries(
            Object.entries(config).filter(([key]) =>
                ["user_token", "user_id", "project_id", "bot_id", "agent_ref", "pairing_runtime_id"].includes(key),
            ),
        );
    }

    /**
     * Moves the state an earlier release kept under Documents into this computer's state directory, but only when its
     * Machine runs on this computer. Documents may sync to the user's other computers: a copy whose Machine runs
     * elsewhere is left to that computer, and this one sets up a Machine of its own instead of replacing that one.
     */
    async function adoptEarlierState(directory: string, base: string | undefined, cwd: string): Promise<void> {
        if ((await readOptionalPrivateJson(join(directory, "config.json"))) !== null) {
            return;
        }
        const earlierDirectory = await earlierStateDirectory();
        const earlierPath = earlierDirectory === null ? null : join(earlierDirectory, "config.json");
        const earlier = earlierPath === null ? null : await readOptionalPrivateJson(earlierPath);
        if (earlierPath === null || earlier === null || typeof earlier["base_url"] !== "string") {
            return;
        }
        const context: Context = {
            directory,
            base: origin(earlier["base_url"]),
            config: savedIdentity(earlier),
            replacement: { kind: "unchanged" },
        };
        if ((base !== undefined && context.base !== base) || !(await runsOnThisComputer(context, cwd))) {
            return;
        }
        await saveConfiguration({ ...context, replacement: readReplacementState(earlier) }, {});
        await rm(earlierPath, { force: true });
        progress("identity", "Moved the saved identity out of Documents into this computer's private state.");
    }

    /** Whether the saved Machine runs here: its bound Runtime, or the one a stopped run paired for it, is managed here. */
    async function runsOnThisComputer(context: Context, cwd: string): Promise<boolean> {
        if (context.config["user_token"] === undefined || context.config["project_id"] === undefined) {
            return false;
        }
        let appId: string;
        let runtimeIds: readonly unknown[];
        try {
            appId = identifier((await request(context, "/management/project"))["appId"]);
            const listed = await request(context, "/management/bots");
            const bot = (Array.isArray(listed["bots"]) ? listed["bots"] : [])
                .map(object)
                .find((item) => context.config["bot_id"] === undefined || item["botId"] === context.config["bot_id"]);
            const binding =
                bot === undefined
                    ? null
                    : await request(
                          context,
                          `/management/bots/${encodeURIComponent(identifier(bot["botId"]))}/runtime-binding`,
                      );
            runtimeIds = [binding?.["runtimeId"], context.config["pairing_runtime_id"]];
        } catch (cause) {
            // An identity this origin no longer accepts names no Machine on any computer.
            if (errorCode(cause) === "UNAUTHENTICATED") {
                return false;
            }
            throw cause;
        }
        return (await listManagedConnections(context, cwd)).some(
            (connection) => connection.appId === appId && runtimeIds.includes(connection.runtimeId),
        );
    }

    async function loadConfiguration(directory: string, base: string): Promise<Context> {
        let config: Readonly<Record<string, unknown>> = {};
        try {
            config = await readPrivateJson(join(directory, "config.json"));
        } catch (cause) {
            if (errorCode(cause) !== "ENOENT") {
                throw cause;
            }
            return { directory, base, config, replacement: { kind: "unchanged" } };
        }
        // Preserve identity and Bot configuration; resolve Runtime connections through the manager.
        const saved = config["base_url"] !== undefined && config["base_url"] !== base ? {} : config;
        return { directory, base, config: savedIdentity(saved), replacement: readReplacementState(saved) };
    }

    /** Decode old file layouts once. Business operations never read or synchronize their overlapping keys. */
    function readReplacementState(config: Readonly<Record<string, unknown>>): ReplacementState {
        const retiring: RetiringIdentity | null =
            config["replaced_project_id"] === undefined && config["replaced_user_token"] === undefined
                ? null
                : {
                      kind: "pending",
                      projectId: identifier(config["replaced_project_id"]),
                      token: credential(config["replaced_user_token"]),
                  };
        const saved = config["replacement_access"];
        if (saved !== undefined) {
            const value = object(saved);
            const previousProjectId = identifier(value["previousProjectId"]);
            switch (value["kind"]) {
                case "unknown":
                    if (previousProjectId !== config["project_id"] || retiring !== null) {
                        fail("INVALID_REPLACEMENT_STATE");
                    }
                    return { kind: "unknown" };
                case "revoked": {
                    const projectId = identifier(value["projectId"]);
                    if (
                        projectId !== config["project_id"] ||
                        (retiring !== null && retiring.projectId !== previousProjectId)
                    ) {
                        fail("INVALID_REPLACEMENT_STATE");
                    }
                    return {
                        kind: "revoked",
                        previous: retiring ?? { kind: "retired", projectId: previousProjectId },
                    };
                }
                default:
                    fail("INVALID_REPLACEMENT_STATE");
            }
        }
        // Earlier setup versions saved only the notification, without the previous Project's ID.
        if (config["replacement_notice"] === "pending") {
            identifier(config["project_id"]);
            return { kind: "revoked", previous: retiring ?? { kind: "retired", projectId: null } };
        }
        return retiring === null ? { kind: "unchanged" } : { kind: "retiring", previous: retiring };
    }

    /** Old setup executables share this file. Derive their fields here so rollback can still finish recovery. */
    function replacementFields(replacement: ReplacementState, projectId: unknown): Readonly<Record<string, unknown>> {
        switch (replacement.kind) {
            case "unchanged":
                return {};
            case "unknown":
                return { replacement_access: { kind: "unknown", previousProjectId: identifier(projectId) } };
            case "retiring":
                return {
                    replaced_project_id: replacement.previous.projectId,
                    replaced_user_token: replacement.previous.token,
                };
            case "revoked":
                return {
                    replacement_notice: "pending",
                    // The old structured decoder requires a previous ID; notice-only files never had one.
                    ...(replacement.previous.projectId === null
                        ? {}
                        : {
                              replacement_access: {
                                  kind: "revoked",
                                  previousProjectId: replacement.previous.projectId,
                                  projectId: identifier(projectId),
                              },
                          }),
                    ...(replacement.previous.kind === "retired"
                        ? {}
                        : {
                              replaced_project_id: replacement.previous.projectId,
                              replaced_user_token: replacement.previous.token,
                          }),
                };
            default: {
                const exhaustive: never = replacement;
                return exhaustive;
            }
        }
    }

    function restoreReplacementAccess(context: Context): void {
        switch (context.replacement.kind) {
            case "unchanged":
            case "retiring":
                replacementAccess = { kind: "unchanged" };
                return;
            case "unknown":
                replacementAccess = { kind: "unknown", previousProjectId: identifier(context.config["project_id"]) };
                return;
            case "revoked":
                replacementAccess = {
                    kind: "revoked",
                    previousProjectId: context.replacement.previous.projectId,
                    projectId: identifier(context.config["project_id"]),
                };
                return;
            default: {
                const exhaustive: never = context.replacement;
                throw exhaustive;
            }
        }
    }

    function replacementFailure(access: ReplacementAccess) {
        if (access.kind === "unchanged") {
            return {};
        }
        return {
            replacementAccess: {
                ...access,
                setupReady,
                message:
                    access.kind === "unknown"
                        ? "The replacement result is unknown. Earlier access may already be revoked; do not assume the old links still work."
                        : setupReady
                          ? "Earlier access was revoked and the new connection is ready, but saving the completion notice failed."
                          : "Earlier sharing links and browser access were revoked, but the new setup has not finished.",
                nextStep:
                    "Report this access state to the user. Keep the saved local identity and retry setup to continue recovery; never clear local state to hide the failure.",
            },
        };
    }

    async function saveConfiguration(context: Context, updates: Readonly<Record<string, unknown>>): Promise<Context> {
        const config: Readonly<Record<string, unknown>> = { ...context.config, ...updates, base_url: context.base };
        const temporary = join(context.directory, `.config-${crypto.randomUUID()}`);
        try {
            await writePrivateJson(temporary, {
                ...config,
                ...replacementFields(context.replacement, config["project_id"]),
            });
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
        if (route === "/management/project/replacement") {
            headers["x-morty-setup-run-id"] = runId;
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
            signal: AbortSignal.any([signal, deadline(45000)]),
        });
        const value = object(await response.json());
        if (!response.ok) {
            remoteFailure(value, response.status);
        }
        return value;
    }

    function remoteFailure(value: Readonly<Record<string, unknown>>, status: number): never {
        const failure = object(value["error"]);
        const code = text(failure["code"], /^[A-Za-z0-9_-]+$/u);
        const message =
            typeof failure["message"] === "string" ? failure["message"] : `Request failed with HTTP ${status}`;
        fail(code, new RemoteError(message));
    }

    /**
     * Ends the local identity of a Project this machine replaced. Setup keeps it with the successor's identity until
     * then, so a run that stops on the way ends it next time instead of leaving a credential that opens the replaced
     * Project. Nothing else from that Project opens it: its replacement ended everything shared from it.
     */
    async function retireReplacedIdentity(context: Context): Promise<Context> {
        const replacement = context.replacement;
        if (
            (replacement.kind !== "revoked" && replacement.kind !== "retiring") ||
            replacement.previous.kind !== "pending"
        ) {
            return context;
        }
        const { projectId, token } = replacement.previous;
        const response = await fetch(
            new URL(`/morty/api/projects/${identifier(projectId)}/identity/v1/local-credential`, context.base),
            {
                method: "DELETE",
                headers: { authorization: `Bearer ${credential(token)}` },
                redirect: "error",
                signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
            },
        );
        // A credential that no longer authenticates was ended by an earlier run that stopped before saving it.
        if (!response.ok && response.status !== 401) {
            remoteFailure(object(await response.json()), response.status);
        }
        return await saveConfiguration(
            {
                ...context,
                replacement:
                    replacement.kind === "retiring"
                        ? { kind: "unchanged" }
                        : { kind: "revoked", previous: { kind: "retired", projectId } },
            },
            {},
        );
    }

    function readSetupOptions(commandArgs: readonly string[]): SetupOptions {
        const { values } = parseArgs({
            args: [...commandArgs],
            options: {
                cwd: { type: "string" },
                harness: { type: "string" },
                "base-url": { type: "string" },
                "session-id": { type: "string" },
                "replace-project": { type: "string" },
            },
        });
        if (values["base-url"] === undefined) {
            fail("BASE_URL_REQUIRED");
        }
        if (values.harness === undefined) {
            fail("HARNESS_REQUIRED");
        }
        if (values.cwd === undefined) {
            fail("WORKING_DIRECTORY_REQUIRED");
        }
        const harness = identifier(values.harness);
        return {
            base: origin(values["base-url"]),
            replaceProject: values["replace-project"] === undefined ? null : identifier(values["replace-project"]),
            cwd: text(values.cwd),
            harness,
            sessionId: currentSessionId(harness, values["session-id"]),
        };
    }

    /**
     * The harness names the Agent's current session in the Agent's own environment. That local value is authoritative
     * over an ID the Agent passes, which only serves harnesses or runs, such as a manual one, without it. Only the
     * declared harness's variable is read: nested Agents inherit their outer harness's variable.
     */
    function currentSessionId(harness: string, argument: string | undefined): string {
        const variable = harnessSessionVariables.get(harness) ?? null;
        const exposed = variable === null ? undefined : (host.agentEnvironment ?? process.env)[variable];
        if (variable !== null && exposed !== undefined && exposed !== "") {
            const sessionId = identifier(exposed);
            if (argument !== undefined && argument !== sessionId) {
                emit({
                    status: "session_id_mismatch",
                    harness,
                    variable,
                    message: `Continuing the session named by ${variable} instead of --session-id.`,
                });
            }
            return sessionId;
        }
        if (argument === undefined) {
            emit({
                status: "session_unavailable",
                harness,
                variable,
                message:
                    variable === null
                        ? "This harness does not expose its current session. Pass --session-id."
                        : `${variable} is not set. Run setup from the Agent's own session, or pass --session-id.`,
            });
            fail("SESSION_ID_REQUIRED");
        }
        return identifier(argument);
    }

    function readRevokeAllAccessOptions(commandArgs: readonly string[]): RevokeAllAccessOptions {
        const { values } = parseArgs({
            args: [...commandArgs],
            options: { "base-url": { type: "string" } },
        });
        return { base: values["base-url"] === undefined ? undefined : origin(values["base-url"]) };
    }

    async function prepareIdentity(context: Context): Promise<SetupIdentity> {
        if (context.config["user_token"] !== undefined) {
            progress("identity", "Reusing the saved identity.");
            return { kind: "setup", context, project: "reused" };
        }
        progress("identity", "Creating the standalone identity and Machine.");
        const identity = await request(context, "/identity/anonymous-users", {}, false);
        const saved = await saveConfiguration(context, {
            user_token: credential(identity["token"]),
            user_id: identifier(identity["userId"]),
            bot_id: identifier(object(identity["bot"])["botId"]),
            project_id: identifier(identity["projectId"]),
        });
        return { kind: "setup", context: saved, project: "created" };
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
            if (code === MOBIUS_EXIT_STATE_ROOT_INVALID) {
                throw new MobiusStateRootError(logPath);
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
                            // A command that ignores SIGTERM is killed in the next round.
                            await exited.catch(() => undefined);
                        }
                    }
                } catch {
                    // Cleanup must not replace the launch failure or prevent its diagnostic from being written.
                }
            }
            operation.throwIfAborted();
            if (errorCode(cause) === "RUNTIME_NOT_INSTALLED" || cause instanceof MobiusStateRootError) {
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
        const previousProjectId = identifier(context.config["project_id"]);
        const pending: ReplacementAccess = { kind: "unknown", previousProjectId };
        // Save before the request: a timeout or interrupted process cannot prove that access was not revoked.
        const prepared = await saveConfiguration({ ...context, replacement: { kind: "unknown" } }, {});
        replacementAccess = pending;
        progress("replacement", "Replacing the saved connection with approval. Earlier shared access will be revoked.");
        const replacement = await request(prepared, "/management/project/replacement", {});
        const projectId = identifier(replacement["projectId"]);
        replacementAccess = { kind: "revoked", previousProjectId, projectId };
        // Report the access change immediately, even if saving or connecting the successor fails next.
        emit({
            status: "replacement_access_revoked",
            previousProjectId,
            projectId,
            message:
                "Earlier sharing links and browser access have been revoked. The new connection is still being set up.",
        });
        const saved = await saveConfiguration(
            {
                ...prepared,
                replacement: {
                    kind: "revoked",
                    previous: {
                        kind: "pending",
                        projectId: previousProjectId,
                        token: credential(context.config["user_token"]),
                    },
                },
            },
            {
                user_token: credential(replacement["token"]),
                user_id: identifier(replacement["userId"]),
                bot_id: identifier(object(replacement["bot"])["botId"]),
                project_id: projectId,
                // The replacement Machine starts unbound; drop the previous Machine's Agent binding.
                agent_ref: undefined,
                pairing_runtime_id: undefined,
            },
        );
        emit({ status: "project_replaced", botId: saved.config["bot_id"], projectId: saved.config["project_id"] });
        return await retireReplacedIdentity(saved);
    }

    async function prepareRuntime(
        context: Context,
        cwd: string,
        expectedRuntimeId: string | null,
        confirmedProjectId: string | null,
    ): Promise<{ readonly context: Context; readonly runtime: RuntimeSelection }> {
        progress("pairing", "Preparing the Runtime connection.");
        const project = await request(context, "/management/project");
        const appId = identifier(project["appId"]);
        const replaceWithApproval = async (reason: ReplacementReason, managedConnectionCount: number | null) => {
            const projectId = identifier(context.config["project_id"]);
            emit({
                status: "replacement_check",
                reason,
                projectId,
                expectedRuntimeId,
                managedConnectionCount,
                approved: confirmedProjectId === projectId,
                platform: process.platform,
                nodeVersion: process.versions.node,
                runtimeStateSource: process.env["MOBIUS_STATE_DIRECTORY"]?.trim() ? "environment" : "default",
            });
            if (confirmedProjectId !== projectId) {
                throw new ProjectReplacementRequiredError(projectId, reason);
            }
            const replaced = await replaceProject(context);
            return await pairRuntime(replaced, appId);
        };
        // A restored local pairing cannot settle whether a previous request revoked shared access.
        // Finish that idempotent operation with its original approval before reporting setup ready.
        if (context.replacement.kind === "unknown") {
            return await replaceWithApproval("replacement_result_unknown", null);
        }
        const reusable = async (runtimeId: string) => {
            const connections = await listManagedConnections(context, cwd);
            const existing = connections.find(
                (connection) => connection.appId === appId && connection.runtimeId === runtimeId,
            );
            if (existing !== undefined) {
                emit({
                    status: "runtime_reused",
                    runtimeId: existing.runtimeId,
                    connectionId: existing.connectionId,
                });
            }
            return { existing, managedConnectionCount: connections.length };
        };
        if (expectedRuntimeId !== null) {
            const { existing, managedConnectionCount } = await reusable(expectedRuntimeId);
            if (existing !== undefined) {
                return { context, runtime: { kind: "existing", ...existing, bound: true } };
            }
            // Losing the local pairing does not itself authorize ending shared access.
            return await replaceWithApproval("managed_runtime_missing", managedConnectionCount);
        }
        // The Machine is unbound. A Runtime an earlier run paired for it still holds one of the Project's Runtime
        // slots, so continue on it while this machine still manages its connection.
        const pairing = context.config["pairing_runtime_id"];
        if (typeof pairing === "string") {
            const { existing } = await reusable(pairing);
            if (existing !== undefined) {
                return { context, runtime: { kind: "existing", ...existing, bound: false } };
            }
        }
        return await pairRuntime(context, appId);
    }

    /**
     * Pairs a new Runtime for the unbound Machine. The Runtime is recorded before its code is redeemed, so a run that
     * stops at any later point leaves the next run a Runtime to continue on rather than another one to pair.
     */
    async function pairRuntime(
        context: Context,
        appId: string,
    ): Promise<{ readonly context: Context; readonly runtime: RuntimeSelection }> {
        const runtime = await createRuntimePairing(context, appId);
        return { context: await saveConfiguration(context, { pairing_runtime_id: runtime.runtimeId }), runtime };
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
    async function upgradeRuntime(context: Context, cwd: string): Promise<void> {
        // The upgrade has its own budget so a slow download leaves setup time to reuse the running daemon.
        const budget = deadline(RUNTIME_UPGRADE_BUDGET_MILLISECONDS);
        try {
            // The daemon is already running here, so the upgrade command never launches it and
            // stopping the command's process tree cannot stop the daemon.
            await runMobius(context, ["upgrade"], cwd, AbortSignal.any([signal, budget]), "process-tree");
            emit({ status: "runtime_upgrade_checked" });
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

    /** The Agents the Runtime offers while it is online, or null while it is not. */
    async function onlineRuntimeAgents(context: Context, runtime: RuntimeSelection): Promise<readonly string[] | null> {
        const botPath = `/chat/projects/${context.config["project_id"]}/bots/${context.config["bot_id"]}`;
        // A bound Machine's Runtime is read through the Machine; an unbound one is among the setup candidates.
        const alreadyConfigured = runtime.kind === "existing" && runtime.bound;
        const state = await request(context, `${botPath}/${alreadyConfigured ? "workspace" : "setup/runtimes"}`, {});
        const candidates = alreadyConfigured
            ? [object(state["runtime"])]
            : Array.isArray(state["runtimes"])
              ? state["runtimes"].map(object)
              : [];
        const current = candidates.find(
            (candidate) => candidate["runtimeId"] === runtime.runtimeId && candidate["online"] === true,
        );
        if (current === undefined || !Array.isArray(current["agents"])) {
            return null;
        }
        return current["agents"].map((agent) => identifier(object(agent)["agentRef"]));
    }

    async function runtimeIsOnline(context: Context, runtime: RuntimeSelection, harness: string): Promise<boolean> {
        return (await onlineRuntimeAgents(context, runtime))?.includes(harness) === true;
    }

    /** One rule for every Runtime setup waits on: an online Runtime without the chosen harness cannot run it. */
    async function harnessUnavailable(
        context: Context,
        harness: string,
        available: readonly string[],
        cwd: string,
    ): Promise<never> {
        emit({ status: "harness_unavailable", harness, available });
        throw new HarnessUnavailableError(harness, await diagnoseHarness(context, harness, cwd));
    }

    /**
     * Asks this computer's Mobius why it does not offer the harness. The published catalog omits unusable Agents, but
     * the local inventory keeps their status and recovery command. Without an answer, setup still fails as unavailable.
     */
    async function diagnoseHarness(context: Context, harness: string, cwd: string): Promise<HarnessDiagnosis | null> {
        const outputPath = join(tmpdir(), `mobius-agents-${crypto.randomUUID()}.json`);
        try {
            await writePrivateFile(outputPath, "");
            await runMobius(
                context,
                ["agents", `--output-json=${outputPath}`],
                cwd,
                AbortSignal.any([signal, deadline(60_000)]),
                "process-tree",
            );
            const inventory = object(JSON.parse(await readFile(outputPath, "utf8")));
            const entry = [inventory["unavailable"], inventory["available"]]
                .flatMap((agents) => (Array.isArray(agents) ? agents : []))
                .map(object)
                .find((agent) => agent["id"] === harness);
            if (entry === undefined) {
                return null;
            }
            const field = (name: string) => {
                const value = entry[name];
                return typeof value === "string" && value.length <= 200 && !/[\r\n]/u.test(value) ? value : "";
            };
            return {
                status: field("status") || "unknown",
                label: field("label") || harness,
                recoveryCommand: field("recoveryCommand"),
                minimumSupportedVersion: field("minimumSupportedVersion"),
            };
        } catch (cause) {
            // Cancellation and the setup budget keep their own codes; any other failure, such as a Mobius release
            // without `agents --output-json`, leaves the harness unavailable without a diagnosis.
            if (signal.aborted) {
                throw cause;
            }
            return null;
        } finally {
            await rm(outputPath, { force: true });
        }
    }

    async function waitForRuntime(context: Context, runtime: RuntimeSelection, harness: string, cwd: string) {
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
                    await harnessUnavailable(
                        context,
                        harness,
                        status["agents"].map((agent) => identifier(object(agent)["id"])),
                        cwd,
                    );
                }
                await clock.wait(1000, signal);
            }
        }

        attempts = 0;
        // When the online Runtime was first seen without the harness. Only a catalog that stayed without it through
        // the grace period means the harness is not installed.
        let missingSince: number | null = null;
        while (true) {
            signal.throwIfAborted();
            const agents = await onlineRuntimeAgents(context, runtime);
            if (agents?.includes(harness) === true) {
                if (runtime.kind === "existing") {
                    emit({ status: "runtime_paired", runtimeId, harness });
                }
                emit({ status: "runtime_online", runtimeId, harness });
                return;
            }
            if (agents === null) {
                missingSince = null;
            } else {
                const now = clock.now().getTime();
                missingSince ??= now;
                if (now - missingSince >= HARNESS_CATALOG_GRACE_MILLISECONDS) {
                    await harnessUnavailable(context, harness, agents, cwd);
                }
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
        try {
            await request(
                context,
                `/chat/projects/${context.config["project_id"]}/bots/${context.config["bot_id"]}/setup`,
                {
                    runtimeId,
                    agentRef,
                },
            );
        } catch (cause) {
            // Cancellation and the setup budget keep their own codes.
            if (signal.aborted || !(cause instanceof Error)) {
                throw cause;
            }
            if (cause.name === "TimeoutError") {
                throw new AgentBindingError("TIMEOUT", harness, cause);
            }
            const code = errorCode(cause);
            if (cause.cause instanceof RemoteError && typeof code === "string") {
                throw new AgentBindingError(code, harness, cause);
            }
            throw cause;
        }
        // The Machine now owns its Runtime, so the pairing record is no longer needed.
        const saved = await saveConfiguration(context, {
            agent_ref: agentRef,
            pairing_runtime_id: undefined,
        });
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

    async function finishSetup(
        context: Context,
        runtime: RuntimeSelection,
        options: SetupOptions,
        identity: SetupIdentity["project"],
    ) {
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
        const project: ProjectOutcome = context.replacement.kind === "revoked" ? "replaced" : identity;
        emit({
            status: "ready",
            botId,
            url: handoffUrl,
            workspace: workingDirectory,
            qrPath: qr.kind === "available" ? qr.path : null,
            project,
            message:
                qr.kind === "available"
                    ? "Open the link or scan the QR code to chat. Keep the Runtime online."
                    : "Open the link to chat. Keep the Runtime online.",
        });
        setupReady = true;
        if (project === "replaced") {
            // Cleared only after ready reported it, so a run that stops earlier leaves the notice owed.
            await saveConfiguration({ ...context, replacement: { kind: "unchanged" } }, {});
        }
    }

    async function revokeAllAccess(options: RevokeAllAccessOptions) {
        const directory = await prepareStateDirectory(resolveStateDirectory(host.state, signal));
        await adoptEarlierState(directory, options.base, directory);
        let config: Readonly<Record<string, unknown>>;
        try {
            config = await readPrivateJson(join(directory, "config.json"));
        } catch (cause) {
            if (errorCode(cause) === "ENOENT") {
                fail("LOCAL_IDENTITY_REQUIRED");
            }
            throw cause;
        }
        if (config["user_token"] === undefined || config["project_id"] === undefined) {
            fail("LOCAL_IDENTITY_REQUIRED");
        }
        const base = origin(config["base_url"]);
        // Never send the saved identity to a different origin, even when explicitly requested.
        if (options.base !== undefined && options.base !== base) {
            fail("LOCAL_IDENTITY_REQUIRED");
        }
        const context = await retireReplacedIdentity({
            directory,
            base,
            config: Object.fromEntries(
                Object.entries(config).filter(
                    ([key]) =>
                        ![
                            "replacement_access",
                            "replacement_notice",
                            "replaced_project_id",
                            "replaced_user_token",
                            "agent_config_revision",
                        ].includes(key),
                ),
            ),
            replacement: readReplacementState(config),
        });
        const revoked = await request(context, "/identity/revoke-all-access", {});
        if (revoked["status"] !== "access_revoked") {
            fail("INVALID_RESPONSE");
        }
        emit({
            status: "access_revoked",
            projectId: identifier(context.config["project_id"]),
            message:
                "Previous sharing links and other Morty credentials have been revoked. The local identity is retained. Existing session connections may remain usable until their access expires.",
        });
    }

    async function preflightRuntime(context: Context, cwd: string) {
        progress("preflight", "Checking Node.js, npm and the installed Runtime before creating an identity.");
        const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
        if (major < 22 || (major === 22 && minor < 19)) {
            throw new RuntimePreflightError(
                `Node.js 22.19.0 or newer is required; found ${process.versions.node} at ${process.execPath}.`,
            );
        }
        try {
            // This uses the same executable resolution as start/pair, including the Node
            // selected by its launcher. A package's engines field is not proof it starts.
            await runMobius(context, ["--version"], cwd, AbortSignal.any([signal, deadline(30_000)]), "process-tree");
            if (host.runtime === undefined) {
                const npm = await findExecutableOnPath("npm", process.env);
                if (npm === null) {
                    throw new Error("npm is required for Runtime upgrades");
                }
                await runBoundedProcess({
                    command: npm.path,
                    arguments: ["--version"],
                    cwd,
                    environment: process.env,
                    signal,
                    timeoutMilliseconds: 10_000,
                    outputLimitBytes: 4096,
                });
            }
        } catch (cause) {
            signal.throwIfAborted();
            // The installation is fine; the shell names the wrong state root.
            if (cause instanceof MobiusStateRootError) {
                throw cause;
            }
            throw new RuntimePreflightError(
                "The local Runtime failed its startup check. No remote identity or pairing was created by this run.",
                cause,
            );
        }
        emit({ status: "runtime_verified", nodeVersion: process.versions.node, nodeExecutable: process.execPath });
    }

    async function setup(options: SetupOptions) {
        const cwd = await resolveWorkingDirectory(options.cwd);
        const directory = await prepareStateDirectory(resolveStateDirectory(host.state, signal));
        // A previous replacement must still be explained when this run fails its local startup checks.
        restoreReplacementAccess(await loadConfiguration(directory, options.base));
        await preflightRuntime({ directory, base: options.base, config: {}, replacement: { kind: "unchanged" } }, cwd);
        await adoptEarlierState(directory, options.base, cwd);
        let context = await loadConfiguration(directory, options.base);
        restoreReplacementAccess(context);
        context = await retireReplacedIdentity(context);
        const identity = await prepareIdentity(context);
        context = identity.context;
        const verified = await verifyIdentityAndBot(context);
        context = verified.context;
        emit({ status: "identity_ready", userId: context.config["user_id"], botId: context.config["bot_id"] });
        const prepared = await prepareRuntime(context, cwd, verified.expectedRuntimeId, options.replaceProject);
        context = prepared.context;
        context = await startRuntime(context, prepared.runtime, cwd, options.harness);
        await waitForRuntime(context, prepared.runtime, options.harness, cwd);
        await upgradeRuntime(context, cwd);
        // A release switch reconnects the Runtime, and the manager finishes a switch even
        // when setup stopped waiting for the upgrade, so wait for it before binding.
        await waitForRuntime(context, prepared.runtime, options.harness, cwd);
        context = await bindAgent(context, prepared.runtime, options.harness);
        await finishSetup(context, prepared.runtime, options, identity.project);
    }

    try {
        const action = args[0];
        const commandArgs = args.slice(1);
        switch (action) {
            case "setup":
                await setup(readSetupOptions(commandArgs));
                break;
            case "revoke-all-access":
                await revokeAllAccess(readRevokeAllAccessOptions(commandArgs));
                break;
            default:
                fail("INVALID_ARGUMENTS");
        }
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
                ...(cause instanceof MobiusStateRootError
                    ? { runtime: cause.diagnostic(replacementAccess) }
                    : cause instanceof RuntimeStartError || cause instanceof RuntimePreflightError
                      ? { runtime: cause.diagnostic() }
                      : {}),
                ...(cause instanceof AgentBindingError ? { binding: cause.diagnostic() } : {}),
                ...(cause instanceof HarnessUnavailableError ? { harness: cause.diagnostic() } : {}),
                ...(cause instanceof ProjectReplacementRequiredError ? { replacement: cause.diagnostic() } : {}),
                ...replacementFailure(replacementAccess),
            },
        });
        return 1;
    }
}
