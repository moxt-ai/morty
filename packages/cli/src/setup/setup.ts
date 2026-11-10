import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { decodeIdentifier, isIdentifier } from "@morty-build/client/protocol";
import { claimMortyState, mortyStateDirectory } from "@morty-build/local-state";
import jsQrImport from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import { validateLocalPath } from "../engine/util/filesystem/private-path.ts";
import { spawnProcess, stopProcessTree } from "../engine/util/process/executable.ts";

export interface SetupRuntime {
    /** Runs a Morty command; `input`, when given, is written to its standard input, which is then closed. */
    readonly run: (
        directory: string,
        args: readonly string[],
        cwd: string,
        signal: AbortSignal,
        input?: string,
    ) => Promise<{
        readonly pid: number;
        readonly logPath: string;
    }>;
}

interface SetupEnvironment {
    /**
     * Where this computer keeps Morty's private state. Empty selects the operating system's local application data directory,
     * which is not synced to the user's other computers.
     */
    readonly state: string;
    readonly signal: AbortSignal;
    readonly emit: (value: Readonly<Record<string, unknown>>) => void;
    /** The calling Agent's environment, where its harness exposes the current session. Defaults to this process's. */
    readonly agentEnvironment?: Readonly<Record<string, string | undefined>>;
    readonly clock?: {
        readonly now: () => Date;
        readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
        /** A signal that aborts once the duration elapses. */
        readonly deadline?: (milliseconds: number) => AbortSignal;
    };
}

export type SetupHost = SetupEnvironment &
    (
        | { readonly runtime: SetupRuntime }
        | { /** The invoking CLI release, never another release resolved through npm. */ readonly cliEntry: string }
    );

/** Where each supported harness exposes its current session to the commands its Agent runs. */
const harnessSessionVariables: ReadonlyMap<string, string> = new Map([
    ["claude", "CLAUDE_CODE_SESSION_ID"],
    ["codex", "CODEX_THREAD_ID"],
    ["pi", "PI_SESSION_ID"],
]);

interface RetiringIdentity {
    readonly kind: "pending";
    readonly computerId: string;
    readonly token: string;
}

type ReplacementState =
    | { readonly kind: "unchanged" }
    | { readonly kind: "unknown" }
    | {
          readonly kind: "revoked";
          readonly previous: RetiringIdentity | { readonly kind: "retired"; readonly computerId: string };
      };

/** The identity that a bootstrap or replacement returned. */
interface IssuedIdentity {
    readonly userToken: string;
    readonly userId: string;
    readonly computerId: string;
}

/** The key naming an identity being created, saved before the request so a retried run resumes the same identity. */
interface CreatingIdentity {
    readonly kind: "creating";
    readonly creationKey: string;
}

type PairingIntent = { readonly kind: "none" } | { readonly kind: "requesting"; readonly requestKey: string };

/**
 * Revoking all access also replaces the local credential, so a copy of it stops working too. Setup saves the successor
 * before the request: a lost reply then leaves one of the two credentials in force, never neither.
 */
type CredentialRotation = { readonly kind: "none" } | { readonly kind: "requested"; readonly successor: string };

interface ReadyIdentity extends IssuedIdentity {
    readonly kind: "ready";
    /** Setup owns the unfinished pairing intent; the Worker owns the final Machine binding. */
    readonly pairing: PairingIntent;
    readonly replacement: ReplacementState;
    readonly rotation: CredentialRotation;
}

/**
 * What this computer's setup holds for the one Morty service its state directory belongs to. Only setup's intent is
 * kept here; the Runtime owns its pairings and connections in its own state.
 */
type IdentityState = { readonly kind: "none" } | CreatingIdentity | ReadyIdentity;

/** The saved setup state. The service origin is part of the identity, never a setting that selects another one. */
interface SavedState {
    readonly base: string;
    readonly identity: CreatingIdentity | ReadyIdentity;
}

/** Version of the saved state's representation; any other representation is refused, never converted. */
const SAVED_STATE_VERSION = 3;

function createdIdentity(issued: IssuedIdentity): ReadyIdentity {
    return {
        kind: "ready",
        ...issued,
        pairing: { kind: "none" },
        replacement: { kind: "unchanged" },
        rotation: { kind: "none" },
    };
}

function withoutPairingIntent(identity: ReadyIdentity): ReadyIdentity {
    return { ...identity, pairing: { kind: "none" } };
}

/** Saved before the replacement request: a lost reply cannot prove that access was not revoked. */
function withReplacementRequested(identity: ReadyIdentity): ReadyIdentity {
    return { ...identity, replacement: { kind: "unknown" } };
}

/** The successor identity, keeping the replaced one until it is ended. */
function replacedIdentity(previous: ReadyIdentity, successor: IssuedIdentity): ReadyIdentity {
    return {
        kind: "ready",
        ...successor,
        pairing: { kind: "none" },
        replacement: {
            kind: "revoked",
            previous: { kind: "pending", computerId: previous.computerId, token: previous.userToken },
        },
        rotation: { kind: "none" },
    };
}

function withPreviousRetired(identity: ReadyIdentity, previous: RetiringIdentity): ReadyIdentity {
    return {
        ...identity,
        replacement: { kind: "revoked", previous: { kind: "retired", computerId: previous.computerId } },
    };
}

/** Saved before the request that makes `successor` the only local credential. */
function withRotationRequested(identity: ReadyIdentity, successor: string): ReadyIdentity {
    return { ...identity, rotation: { kind: "requested", successor } };
}

/** The local credential after the Worker replaced it with the requested successor. */
function rotatedIdentity(identity: ReadyIdentity, successor: string): ReadyIdentity {
    return { ...identity, userToken: successor, rotation: { kind: "none" } };
}

/** Cleared only after a finished setup reported the replacement. */
function withReplacementReported(identity: ReadyIdentity): ReadyIdentity {
    return { ...identity, replacement: { kind: "unchanged" } };
}

function encodeReplacement(replacement: ReplacementState) {
    switch (replacement.kind) {
        case "unchanged":
        case "unknown":
            return { kind: replacement.kind };
        case "revoked":
            return {
                kind: "revoked",
                previous:
                    replacement.previous.kind === "pending"
                        ? {
                              kind: "pending",
                              computer_id: replacement.previous.computerId,
                              user_token: replacement.previous.token,
                          }
                        : { kind: "retired", computer_id: replacement.previous.computerId },
            };
        default: {
            const exhaustive: never = replacement;
            return exhaustive;
        }
    }
}

function encodeSavedState(state: SavedState) {
    const identity = state.identity;
    switch (identity.kind) {
        case "creating":
            return {
                version: SAVED_STATE_VERSION,
                base_url: state.base,
                identity: { kind: "creating", creation_key: identity.creationKey },
            };
        case "ready":
            return {
                version: SAVED_STATE_VERSION,
                base_url: state.base,
                identity: {
                    kind: "ready",
                    user_id: identity.userId,
                    user_token: identity.userToken,
                    computer_id: identity.computerId,
                    pairing: identity.pairing,
                    replacement: encodeReplacement(identity.replacement),
                    // Present only while a rotation is requested; a state without one keeps its representation.
                    ...(identity.rotation.kind === "requested"
                        ? { credential_rotation: { successor_token: identity.rotation.successor } }
                        : {}),
                },
            };
        default: {
            const exhaustive: never = identity;
            return exhaustive;
        }
    }
}

/** Where setup keeps its state, and the one Morty service that state belongs to. */
interface StateLocation {
    readonly directory: string;
    readonly base: string;
}

/** A run whose saved identity can authenticate with the service. */
interface Context extends StateLocation {
    readonly identity: ReadyIdentity;
}

type RuntimeSelection =
    | {
          readonly kind: "existing";
          readonly computerId: string;
          /** Whether the Relay records this Runtime as the computer's paired Runtime. */
          readonly paired: boolean;
      }
    | {
          readonly kind: "pairing";
          readonly pairingCode: string;
          readonly computerId: string;
          readonly relayUrl: string;
      };

interface ManagedConnection {
    readonly computerId: string;
}

interface VerifiedIdentity {
    readonly context: Context;
    /** Where the Machine's Runtime pairing stands, as the Relay records it. */
    readonly runtimePairing: "unpaired" | "paired" | "revoked";
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
    /** How long the browser that opens setup's link keeps access, or null for Morty's default; Morty validates it. */
    readonly deviceAccess: string | null;
    readonly cwd: string;
    readonly harness: string;
    readonly sessionId: string;
    /** Explicit local approval applies only to this Project, never to a later replacement. */
    readonly replaceProject: string | null;
}

type ReplacementAccess =
    | { readonly kind: "unchanged" }
    | { readonly kind: "unknown"; readonly previousComputerId: string }
    | { readonly kind: "revoked"; readonly previousComputerId: string; readonly computerId: string };

type ReplacementReason = "managed_runtime_missing" | "replacement_result_unknown";

class ProjectReplacementRequiredError extends Error {
    readonly code = "PROJECT_REPLACEMENT_REQUIRED";
    readonly computerId: string;
    readonly reason: ReplacementReason;

    constructor(computerId: string, reason: ReplacementReason) {
        super(
            reason === "managed_runtime_missing"
                ? "The saved connection is missing. Replacing it will revoke earlier sharing links and browser access."
                : "An earlier replacement has an unknown result. Continue only with approval for that same Project.",
        );
        this.name = "ProjectReplacementRequiredError";
        this.computerId = computerId;
        this.reason = reason;
    }

    readonly diagnostic = () => ({
        computerId: this.computerId,
        reason: this.reason,
        nextStep:
            "Explain the access impact and ask the user whether to continue, unless they already explicitly approved this same replacement. " +
            `Only after explicit approval, rerun the same setup command with --replace-computer ${this.computerId}. ` +
            "Do not remove local state or create another identity to bypass this confirmation.",
    });
}

/** The state directory belongs to another Morty service. Its identity is never sent elsewhere or replaced. */
class SavedIdentityOriginError extends Error {
    readonly code = "SAVED_IDENTITY_ORIGIN_MISMATCH";
    readonly savedBaseUrl: string;
    readonly requestedBaseUrl: string;

    constructor(savedBaseUrl: string, requestedBaseUrl: string) {
        super(`This state directory holds the Morty identity for ${savedBaseUrl}, not ${requestedBaseUrl}.`);
        this.name = "SavedIdentityOriginError";
        this.savedBaseUrl = savedBaseUrl;
        this.requestedBaseUrl = requestedBaseUrl;
    }

    readonly diagnostic = () => ({
        savedBaseUrl: this.savedBaseUrl,
        requestedBaseUrl: this.requestedBaseUrl,
        nextStep:
            `Setup changed nothing. To keep using the saved identity, rerun with --base-url ${this.savedBaseUrl}. ` +
            `To set up ${this.requestedBaseUrl} as well, rerun with MORTY_STATE_DIRECTORY set to a separate empty directory. ` +
            "Never remove or edit the saved state to bypass this: it holds the only credential for the saved identity.",
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
        "Inspect the Runtime log, then run morty start and rerun setup. Check morty --version when diagnosing startup; setup does not stop an existing daemon.";

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
        "Use Node.js 22.19+ or 24.20+, run morty --version in the same terminal, and repair the installed Morty release before rerunning setup.";

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

/** `morty` exits with EX_CONFIG (78) when MORTY_STATE_DIRECTORY names another root's installation data. */
const MORTY_EXIT_STATE_ROOT_INVALID = 78;

/** Morty refused this shell's state root; setup must not continue against a state it cannot see. */
class MortyStateRootError extends Error {
    readonly code = "MORTY_STATE_ROOT_INVALID";
    readonly logPath: string;
    readonly nextStep =
        "This shell's MORTY_STATE_DIRECTORY names Morty installation data that an earlier Morty Runtime passed to this agent, not a state root. Rerun setup with MORTY_STATE_DIRECTORY set to the state root that the Runtime log names.";

    constructor(logPath: string) {
        super(`Morty refused this shell's state root. See ${logPath}.`);
        this.name = "MortyStateRootError";
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
        case "RELAY_TIMEOUT":
        case "RELAY_UNAVAILABLE":
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

/** Why the local Agent inventory says the chosen harness cannot run, as `morty agents` reports it. */
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
            return `Morty cannot find ${diagnosis.label} on this computer. Make sure \`${harness}\` runs in a new terminal, then ${rerun} Do not switch to another harness.`;
        case "missing_adapter":
            return diagnosis.recoveryCommand.length > 0
                ? `Install the ${diagnosis.label} adapter by running \`${diagnosis.recoveryCommand}\`, then ${rerun}`
                : `Install the ${diagnosis.label} adapter, then ${rerun}`;
        case "unsupported_version":
            return `Update ${diagnosis.label} to ${diagnosis.minimumSupportedVersion || "its latest release"} or newer, then ${rerun}`;
        case "ready":
            // Morty refreshes a running Runtime's Agents when setup starts it.
            return `${diagnosis.label} is ready, but this computer's running Morty Runtime has not picked it up yet. Rerun setup once. If it fails the same way again, ask the user before running \`morty stop\`, because it stops every Morty session on this computer; when they agree, run it and ${rerun}`;
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
        .replace(/morty_anon_v1_[A-Za-z0-9_-]+|morty_(?:transfer_v1|recovery_v1)\.[A-Za-z0-9._-]+/gu, "[REDACTED]")
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
    const credential = (value: unknown) => text(value, /^morty_anon_v1_[A-Za-z0-9_-]{43}$/u);

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
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await safeLocalPath(directory, true, false);
        await claimMortyState(directory, signal);
        await safeLocalPath(directory, true, true);
        signal.throwIfAborted();
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

    /** Decodes exactly the representation this Setup writes. Any other state is refused, never converted or rewritten. */
    function decodeSavedState(value: unknown): SavedState {
        const invalid = (): never => fail("INVALID_CONFIGURATION");
        const fieldsOf = (input: unknown): Readonly<Record<string, unknown>> => {
            if (input === null || typeof input !== "object" || Array.isArray(input)) {
                return invalid();
            }
            return Object.fromEntries(Object.entries(input));
        };
        const exactly = (input: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> => {
            const fields = fieldsOf(input);
            const names = Object.keys(fields);
            if (names.length !== keys.length || names.some((name) => !keys.includes(name))) {
                invalid();
            }
            return fields;
        };
        const savedIdentifier = (input: unknown): string => (isIdentifier(input) ? input : invalid());
        const savedCredential = (input: unknown): string =>
            typeof input === "string" && /^morty_anon_v1_[A-Za-z0-9_-]{43}$/u.test(input) ? input : invalid();
        const savedOrigin = (input: unknown): string => {
            try {
                if (origin(input) === input) {
                    return input;
                }
            } catch {
                // Reported as an invalid configuration below.
            }
            return invalid();
        };
        const replacement = (input: unknown): ReplacementState => {
            switch (fieldsOf(input)["kind"]) {
                case "unchanged":
                    exactly(input, ["kind"]);
                    return { kind: "unchanged" };
                case "unknown":
                    exactly(input, ["kind"]);
                    return { kind: "unknown" };
                case "revoked": {
                    const previous = exactly(input, ["kind", "previous"])["previous"];
                    switch (fieldsOf(previous)["kind"]) {
                        case "pending": {
                            const fields = exactly(previous, ["kind", "computer_id", "user_token"]);
                            return {
                                kind: "revoked",
                                previous: {
                                    kind: "pending",
                                    computerId: savedIdentifier(fields["computer_id"]),
                                    token: savedCredential(fields["user_token"]),
                                },
                            };
                        }
                        case "retired": {
                            const fields = exactly(previous, ["kind", "computer_id"]);
                            return {
                                kind: "revoked",
                                previous: { kind: "retired", computerId: savedIdentifier(fields["computer_id"]) },
                            };
                        }
                        default:
                            return invalid();
                    }
                }
                default:
                    return invalid();
            }
        };
        const pairingIntent = (value: unknown): PairingIntent => {
            switch (fieldsOf(value)["kind"]) {
                case "none":
                    exactly(value, ["kind"]);
                    return { kind: "none" };
                case "requesting": {
                    const fields = exactly(value, ["kind", "requestKey"]);
                    return { kind: "requesting", requestKey: savedIdentifier(fields["requestKey"]) };
                }
                default:
                    return invalid();
            }
        };
        const saved = exactly(value, ["version", "base_url", "identity"]);
        if (saved["version"] !== SAVED_STATE_VERSION) {
            invalid();
        }
        const base = savedOrigin(saved["base_url"]);
        switch (fieldsOf(saved["identity"])["kind"]) {
            case "creating": {
                const creating = exactly(saved["identity"], ["kind", "creation_key"]);
                const creationKey = creating["creation_key"];
                if (typeof creationKey !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(creationKey)) {
                    return invalid();
                }
                return { base, identity: { kind: "creating", creationKey } };
            }
            case "ready": {
                const keys = ["kind", "user_id", "user_token", "computer_id", "pairing", "replacement"];
                const rotating = "credential_rotation" in fieldsOf(saved["identity"]);
                const ready = exactly(saved["identity"], rotating ? [...keys, "credential_rotation"] : keys);
                return {
                    base,
                    identity: {
                        kind: "ready",
                        userId: savedIdentifier(ready["user_id"]),
                        userToken: savedCredential(ready["user_token"]),
                        computerId: savedIdentifier(ready["computer_id"]),
                        pairing: pairingIntent(ready["pairing"]),
                        replacement: replacement(ready["replacement"]),
                        rotation: rotating
                            ? {
                                  kind: "requested",
                                  successor: savedCredential(
                                      exactly(ready["credential_rotation"], ["successor_token"])["successor_token"],
                                  ),
                              }
                            : { kind: "none" },
                    },
                };
            }
            default:
                return invalid();
        }
    }

    /** The saved state, or null before this computer's first setup. */
    async function readSavedState(directory: string): Promise<SavedState | null> {
        const path = join(directory, "config.json");
        let content: string;
        try {
            await safeLocalPath(path, false, true);
            content = await readFile(path, "utf8");
        } catch (cause) {
            if (errorCode(cause) === "ENOENT") {
                return null;
            }
            throw cause;
        }
        let value: unknown;
        try {
            value = JSON.parse(content);
        } catch {
            fail("INVALID_CONFIGURATION");
        }
        return decodeSavedState(value);
    }

    /** The identity saved for the requested service. A state that belongs to another service is refused unchanged. */
    async function loadIdentity(directory: string, base: string): Promise<IdentityState> {
        const saved = await readSavedState(directory);
        if (saved === null) {
            return { kind: "none" };
        }
        if (saved.base !== base) {
            throw new SavedIdentityOriginError(saved.base, base);
        }
        return saved.identity;
    }

    /** Replaces the saved state atomically; every write follows an explicit identity transition. */
    async function writeSavedState(location: StateLocation, identity: CreatingIdentity | ReadyIdentity) {
        const temporary = join(location.directory, `.config-${crypto.randomUUID()}`);
        try {
            await writePrivateFile(
                temporary,
                JSON.stringify(encodeSavedState({ base: location.base, identity }), null, 2),
            );
            await rename(temporary, join(location.directory, "config.json"));
        } finally {
            await rm(temporary, { force: true });
        }
    }

    async function commit<Saved extends Context>(context: Saved, identity: ReadyIdentity): Promise<Saved> {
        await writeSavedState(context, identity);
        return { ...context, identity };
    }

    function restoreReplacementAccess(identity: IdentityState): void {
        if (identity.kind !== "ready") {
            replacementAccess = { kind: "unchanged" };
            return;
        }
        switch (identity.replacement.kind) {
            case "unchanged":
                replacementAccess = { kind: "unchanged" };
                return;
            case "unknown":
                replacementAccess = { kind: "unknown", previousComputerId: identity.computerId };
                return;
            case "revoked":
                replacementAccess = {
                    kind: "revoked",
                    previousComputerId: identity.replacement.previous.computerId,
                    computerId: identity.computerId,
                };
                return;
            default: {
                const exhaustive: never = identity.replacement;
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

    async function send(base: string, path: string, headers: Readonly<Record<string, string>>, body?: unknown) {
        const response = await fetch(new URL(`/morty/api${path}`, base), {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json", ...headers },
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

    /** Sends a request as the saved identity, to its Project unless the route names one. */
    async function request(context: Context, route: string, body?: unknown) {
        const headers: Record<string, string> = { authorization: `Bearer ${context.identity.userToken}` };
        if (route === "/management/computer/replacement") {
            headers["x-morty-setup-run-id"] = runId;
        }
        const path = route.startsWith("/chat/computers/") ? route : `/computers/${context.identity.computerId}${route}`;
        return await send(context.base, path, headers, body);
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
    async function retireReplacedIdentity<Retiring extends Context>(context: Retiring): Promise<Retiring> {
        const replacement = context.identity.replacement;
        if (replacement.kind !== "revoked" || replacement.previous.kind !== "pending") {
            return context;
        }
        const previous = replacement.previous;
        const response = await fetch(
            new URL(`/morty/api/computers/${previous.computerId}/identity/v1/local-credential`, context.base),
            {
                method: "DELETE",
                headers: { authorization: `Bearer ${previous.token}` },
                redirect: "error",
                signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
            },
        );
        // A credential that no longer authenticates was ended by an earlier run that stopped before saving it.
        if (!response.ok && response.status !== 401) {
            remoteFailure(object(await response.json()), response.status);
        }
        return await commit(context, withPreviousRetired(context.identity, previous));
    }

    /**
     * Revokes every other credential, link and browser access, closes the chat windows open with them, and replaces
     * the local credential with a successor saved first. A run that lost the reply or failed repeats the same request
     * with whichever credential is still in force.
     */
    async function revokeAllAccessWithRotation<Revoking extends Context>(context: Revoking): Promise<Revoking> {
        const earlier = context.identity.rotation;
        const successor =
            earlier.kind === "requested"
                ? earlier.successor
                : `morty_anon_v1_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
        const requested = await commit(context, withRotationRequested(context.identity, successor));
        let revoked: Record<string, unknown>;
        try {
            revoked = await request(requested, "/identity/revoke-all-access", { successor });
        } catch (cause) {
            // The earlier request may have replaced the credential already; the successor then repeats it.
            if (earlier.kind !== "requested" || errorCode(cause) !== "UNAUTHENTICATED") {
                throw cause;
            }
            revoked = await request(
                { ...requested, identity: { ...requested.identity, userToken: successor } },
                "/identity/revoke-all-access",
                { successor },
            );
        }
        if (revoked["status"] !== "access_revoked") {
            fail("INVALID_RESPONSE");
        }
        return await commit(requested, rotatedIdentity(requested.identity, successor));
    }

    /** Finishes revoking all access when an earlier run stopped before saving the replaced local credential. */
    async function settleCredentialRotation<Settling extends Context>(context: Settling): Promise<Settling> {
        if (context.identity.rotation.kind === "none") {
            return context;
        }
        progress("identity", "Finishing the earlier revocation of all access.");
        return await revokeAllAccessWithRotation(context);
    }

    function readSetupOptions(commandArgs: readonly string[]): SetupOptions {
        const { values } = parseArgs({
            args: [...commandArgs],
            options: {
                cwd: { type: "string" },
                harness: { type: "string" },
                "base-url": { type: "string" },
                "session-id": { type: "string" },
                "replace-computer": { type: "string" },
                "device-access": { type: "string" },
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
            deviceAccess: values["device-access"] ?? null,
            replaceProject: values["replace-computer"] === undefined ? null : identifier(values["replace-computer"]),
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

    async function prepareIdentity(location: StateLocation, saved: IdentityState): Promise<SetupIdentity> {
        if (saved.kind === "ready") {
            progress("identity", "Reusing the saved identity.");
            return { kind: "setup", context: { ...location, identity: saved }, project: "reused" };
        }
        progress("identity", "Creating the standalone identity and Machine.");
        // Save the creation key before creating, so a setup retried after a lost reply resumes the same identity
        // instead of creating another.
        let creating: CreatingIdentity;
        if (saved.kind === "creating") {
            creating = saved;
        } else {
            creating = {
                kind: "creating",
                creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
            };
            await writeSavedState(location, creating);
        }
        const created = await send(
            location.base,
            "/identity/anonymous-users",
            {},
            {
                creationKey: creating.creationKey,
            },
        );
        const identity = createdIdentity({
            userToken: credential(created["token"]),
            userId: identifier(created["userId"]),
            computerId: identifier(created["computerId"]),
        });
        await writeSavedState(location, identity);
        return { kind: "setup", context: { ...location, identity }, project: "created" };
    }

    async function verifyIdentityAndMachine(context: Context): Promise<VerifiedIdentity> {
        const session = await request(context, "/session");
        if (identifier(session["userId"]) !== context.identity.userId) {
            fail("IDENTITY_CONFLICT");
        }
        // The Worker reads the Machine's Runtime pairing from the Relay, the same one every browser handoff opens.
        const runtimePairing = text((await request(context, "/management/machine"))["runtimePairing"]);
        if (runtimePairing !== "unpaired" && runtimePairing !== "paired" && runtimePairing !== "revoked") {
            fail("INVALID_RESPONSE");
        }
        return { context, runtimePairing };
    }

    async function runMorty(
        directory: string,
        args: readonly string[],
        cwd: string,
        operation = signal,
        input?: string,
    ) {
        operation.throwIfAborted();
        if ("runtime" in host) {
            return await host.runtime.run(directory, args, cwd, operation, input);
        }
        const logPath = join(directory, `runtime-${crypto.randomUUID()}.log`);
        const log = await open(
            logPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        let child: ChildProcess | undefined;
        try {
            await safeLocalPath(logPath, false, true);
            const localCli = host.cliEntry;
            if (!isAbsolute(localCli)) {
                fail("RUNTIME_NOT_INSTALLED");
            }
            child = spawnProcess(process.execPath, [await realpath(localCli), ...args], {
                cwd,
                stdio: [input === undefined ? "ignore" : "pipe", log.fd, log.fd],
                windowsHide: true,
                env: { ...process.env, MORTY_STATE_DIRECTORY: directory },
            });
            if (input !== undefined) {
                // A Morty that exits before reading reports its own failure; the closed pipe adds nothing.
                child.stdin?.on("error", () => {});
                child.stdin?.end(input);
            }
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
            if (code === MORTY_EXIT_STATE_ROOT_INVALID) {
                throw new MortyStateRootError(logPath);
            }
            if (code !== 0) {
                throw new RuntimeStartError({ kind: "exit", exitCode: code }, logPath);
            }
            return { pid: child.pid, logPath };
        } catch (cause) {
            // Only terminate the child this invocation still owns; an exited PID may be reused.
            if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
                try {
                    // Cancel the whole invocation, including any CLI descendants.
                    await stopProcessTree(child);
                } catch {
                    // Cleanup must not replace the launch failure or prevent its diagnostic from being written.
                }
            }
            operation.throwIfAborted();
            if (errorCode(cause) === "RUNTIME_NOT_INSTALLED" || cause instanceof MortyStateRootError) {
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

    async function listManagedConnections(directory: string, cwd: string): Promise<readonly ManagedConnection[]> {
        const outputPath = join(tmpdir(), `morty-pair-list-${crypto.randomUUID()}.json`);
        await writePrivateFile(outputPath, "");
        try {
            await runMorty(directory, ["pair", "list", `--output-json=${outputPath}`], cwd);
            const value: unknown = JSON.parse(await readFile(outputPath, "utf8"));
            if (!Array.isArray(value)) {
                fail("INVALID_PAIR_LIST");
            }
            return value.map((item) => {
                const connection = object(item);
                return {
                    computerId: identifier(connection["computer_id"]),
                };
            });
        } finally {
            await rm(outputPath, { force: true });
        }
    }

    async function createRuntimePairing(
        context: Context,
        requestKey: string,
    ): Promise<{ readonly runtime: RuntimeSelection; readonly expiresAt: number }> {
        const pairing = await request(context, "/management/pairing", { idempotencyKey: requestKey });
        const selection: RuntimeSelection = {
            kind: "pairing",
            pairingCode: text(pairing["pairingCode"], /^[A-Za-z0-9-]+$/u),
            computerId: identifier(pairing["computerId"]),
            relayUrl: origin(pairing["relayUrl"]),
        };
        if (selection.computerId !== context.identity.computerId) {
            fail("PROJECT_CONFLICT");
        }
        const expiresAt = Date.parse(text(pairing["expiresAt"], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u));
        if (!Number.isFinite(expiresAt)) {
            fail("INVALID_RESPONSE");
        }
        emit({ status: "prepared", computerId: context.identity.computerId });
        return { runtime: selection, expiresAt };
    }

    async function replaceProject(context: Context): Promise<Context> {
        const previousComputerId = context.identity.computerId;
        // Save before the request: a timeout or interrupted process cannot prove that access was not revoked.
        const prepared = await commit(context, withReplacementRequested(context.identity));
        replacementAccess = { kind: "unknown", previousComputerId };
        progress("replacement", "Replacing the saved connection with approval. Earlier shared access will be revoked.");
        const replacement = await request(prepared, "/management/computer/replacement", {});
        const computerId = identifier(replacement["computerId"]);
        replacementAccess = { kind: "revoked", previousComputerId, computerId };
        // Report the access change immediately, even if saving or connecting the successor fails next.
        emit({
            status: "replacement_access_revoked",
            previousComputerId,
            computerId,
            message:
                "Earlier sharing links and browser access have been revoked. The new connection is still being set up.",
        });
        const saved = await commit(
            prepared,
            replacedIdentity(prepared.identity, {
                userToken: credential(replacement["token"]),
                userId: identifier(replacement["userId"]),
                computerId,
            }),
        );
        emit({ status: "project_replaced", computerId: saved.identity.computerId });
        return await retireReplacedIdentity(saved);
    }

    async function prepareRuntime(
        context: Context,
        cwd: string,
        runtimePairing: VerifiedIdentity["runtimePairing"],
        confirmedComputerId: string | null,
    ): Promise<{ readonly context: Context; readonly runtime: RuntimeSelection }> {
        progress("pairing", "Preparing the Runtime connection.");
        const replaceWithApproval = async (reason: ReplacementReason, managedConnectionCount: number | null) => {
            const computerId = context.identity.computerId;
            emit({
                status: "replacement_check",
                reason,
                computerId,
                expectedComputerId: runtimePairing === "unpaired" ? null : computerId,
                managedConnectionCount,
                approved: confirmedComputerId === computerId,
                platform: process.platform,
                nodeVersion: process.versions.node,
                runtimeStateSource: process.env["MORTY_STATE_DIRECTORY"]?.trim() ? "environment" : "default",
            });
            if (confirmedComputerId !== computerId) {
                throw new ProjectReplacementRequiredError(computerId, reason);
            }
            return await pairRuntime(await replaceProject(context));
        };
        // A restored local pairing cannot settle whether a previous request revoked shared access.
        // Finish that idempotent operation with its original approval before reporting setup ready.
        if (context.identity.replacement.kind === "unknown") {
            return await replaceWithApproval("replacement_result_unknown", null);
        }
        // Runtime IDs are unique, so the Runtime's own connection list names the connection that serves one.
        const reusable = async (computerId: string) => {
            const connections = await listManagedConnections(context.directory, cwd);
            const existing = connections.find((connection) => connection.computerId === computerId);
            if (existing !== undefined) {
                emit({
                    status: "runtime_reused",
                    computerId: existing.computerId,
                });
            }
            return { existing, managedConnectionCount: connections.length };
        };
        switch (runtimePairing) {
            case "paired": {
                const { existing, managedConnectionCount } = await reusable(context.identity.computerId);
                if (existing !== undefined) {
                    return { context, runtime: { kind: "existing", ...existing, paired: true } };
                }
                // Losing the local pairing does not itself authorize ending shared access.
                return await replaceWithApproval("managed_runtime_missing", managedConnectionCount);
            }
            case "revoked":
                // Morty disconnected this computer because a copy of its connection key was used. The Machine and the
                // browsers that open it stay; only the computer's connection is paired again.
                emit({ status: "runtime_revoked", computerId: context.identity.computerId });
                progress(
                    "pairing",
                    "Morty disconnected this computer because its connection key was used somewhere else. Pairing it again.",
                );
                // The connection list can retain the revoked credential. Only a new pairing can replace it.
                return await pairRuntime(context);
            case "unpaired": {
                // A Runtime an earlier run started for this computer may still be waiting for its pairing, so continue
                // on it while this machine still manages its connection.
                const { existing } = await reusable(context.identity.computerId);
                if (existing !== undefined) {
                    return { context, runtime: { kind: "existing", ...existing, paired: false } };
                }
                return await pairRuntime(context);
            }
        }
    }

    /**
     * Saves the operation identity before sending it. A lost reply resumes the same pairing; a confirmed expired
     * reservation permits one fresh request. Once answered, Runtime connections supply the pairing fact and the saved intent is cleared.
     */
    async function pairRuntime(
        context: Context,
    ): Promise<{ readonly context: Context; readonly runtime: RuntimeSelection }> {
        let requesting = context;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            signal.throwIfAborted();
            const requestKey =
                requesting.identity.pairing.kind === "requesting"
                    ? requesting.identity.pairing.requestKey
                    : crypto.randomUUID();
            requesting = await commit(requesting, {
                ...requesting.identity,
                pairing: { kind: "requesting", requestKey },
            });
            const { runtime, expiresAt } = await createRuntimePairing(requesting, requestKey);
            if (expiresAt <= clock.now().getTime()) {
                requesting = await commit(requesting, withoutPairingIntent(requesting.identity));
                continue;
            }
            return {
                context: await commit(requesting, withoutPairingIntent(requesting.identity)),
                runtime,
            };
        }
        return fail("RUNTIME_PAIRING_UNAVAILABLE");
    }

    function runtimeCommand(
        runtime: RuntimeSelection,
        cwd: string,
    ): { readonly args: readonly string[]; readonly input?: string } {
        if (runtime.kind === "existing") {
            return { args: ["start"] };
        }
        // The pairing code goes through standard input: a command line is visible to every user of this computer,
        // who could redeem the code while it is valid and take over this Runtime's pairing.
        return {
            args: [
                "pair",
                "--url",
                runtime.relayUrl,
                "--computer",
                runtime.computerId,
                "--code-stdin",
                "--workspace",
                cwd,
            ],
            input: runtime.pairingCode,
        };
    }

    async function startRuntime(
        context: Context,
        runtime: RuntimeSelection,
        cwd: string,
        harness: string,
    ): Promise<void> {
        const reuseOnline = async () => {
            if (runtime.kind !== "existing" || !(await runtimeIsOnline(context, runtime, harness))) {
                return false;
            }
            emit({ status: "runtime_already_online", computerId: runtime.computerId, harness });
            return true;
        };
        // Starting a saved connection is idempotent. Redeeming a one-time pairing is not.
        const maximumAttempts = runtime.kind === "existing" ? 3 : 1;
        for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
            signal.throwIfAborted();
            if (await reuseOnline()) {
                return;
            }
            try {
                const command = runtimeCommand(runtime, cwd);
                const started = await runMorty(context.directory, command.args, cwd, signal, command.input);
                emit({ status: "runtime_started", ...started });
                return;
            } catch (cause) {
                signal.throwIfAborted();
                if (!(cause instanceof RuntimeStartError)) {
                    throw cause;
                }
                // A launcher may fail after the daemon has connected successfully.
                if (await reuseOnline()) {
                    return;
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

    function hasOnlineRuntimeAgent(runtime: Record<string, unknown>, computerId: string, harness: string): boolean {
        return (
            runtime["computerId"] === computerId &&
            runtime["online"] === true &&
            Array.isArray(runtime["agents"]) &&
            runtime["agents"].some((agent) => object(agent)["harness"] === harness)
        );
    }

    /** The Agents the Runtime offers while it is online, or null while it is not. */
    async function onlineRuntimeAgents(context: Context, runtime: RuntimeSelection): Promise<readonly string[] | null> {
        const botPath = `/chat/computers/${context.identity.computerId}`;
        // A paired Runtime is read through the Machine; one still waiting for its pairing is among the setup candidates.
        const alreadyPaired = runtime.kind === "existing" && runtime.paired;
        const state = await request(context, `${botPath}/${alreadyPaired ? "workspace" : "setup/runtimes"}`, {});
        const candidates = alreadyPaired
            ? [object(state["runtime"])]
            : Array.isArray(state["runtimes"])
              ? state["runtimes"].map(object)
              : [];
        const current = candidates.find(
            (candidate) => candidate["computerId"] === runtime.computerId && candidate["online"] === true,
        );
        if (current === undefined || !Array.isArray(current["agents"])) {
            return null;
        }
        return current["agents"].map((agent) => identifier(object(agent)["harness"]));
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
     * Asks this computer's Morty why it does not offer the harness. The published catalog omits unusable Agents, but
     * the local inventory keeps their status and recovery command. Without an answer, setup still fails as unavailable.
     */
    async function diagnoseHarness(context: Context, harness: string, cwd: string): Promise<HarnessDiagnosis | null> {
        const outputPath = join(tmpdir(), `morty-agents-${crypto.randomUUID()}.json`);
        try {
            await writePrivateFile(outputPath, "");
            await runMorty(
                context.directory,
                ["agents", `--output-json=${outputPath}`],
                cwd,
                AbortSignal.any([signal, deadline(60_000)]),
            );
            const inventory = object(JSON.parse(await readFile(outputPath, "utf8")));
            const entry = [inventory["unavailable"], inventory["available"]]
                .flatMap((agents) => (Array.isArray(agents) ? agents : []))
                .map(object)
                .find((agent) => agent["harness"] === harness);
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
            // Cancellation and the setup budget keep their own codes; any other failure leaves the harness unavailable
            // without a diagnosis.
            if (signal.aborted) {
                throw cause;
            }
            return null;
        } finally {
            await rm(outputPath, { force: true });
        }
    }

    async function waitForRuntime(context: Context, runtime: RuntimeSelection, harness: string, cwd: string) {
        const computerId = runtime.computerId;
        let attempts = 0;
        if (runtime.kind === "pairing") {
            while (true) {
                signal.throwIfAborted();
                const status = await request(context, `/management/pairing`);
                if (status["status"] !== "pending" && status["status"] !== "paired") {
                    fail("RUNTIME_PAIRING_UNAVAILABLE");
                }
                if (attempts++ % 10 === 0) {
                    progress("runtime", "Waiting for Runtime pairing to complete.");
                }
                if (status["status"] === "paired") {
                    if (status["computerId"] !== computerId || !Array.isArray(status["agents"])) {
                        fail("INVALID_RESPONSE");
                    }
                    if (status["agents"].some((agent) => object(agent)["harness"] === harness)) {
                        emit({ status: "runtime_paired", computerId, harness });
                        break;
                    }
                    await harnessUnavailable(
                        context,
                        harness,
                        status["agents"].map((agent) => identifier(object(agent)["harness"])),
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
                    emit({ status: "runtime_paired", computerId, harness });
                }
                emit({ status: "runtime_online", computerId, harness });
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
        const computerId = runtime.computerId;
        try {
            await request(context, `/chat/computers/${context.identity.computerId}/setup`, {
                computerId,
                harness,
            });
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
        // The Relay records the Runtime the computer paired, so the local pairing record is no longer needed.
        const saved = await commit(context, withoutPairingIntent(context.identity));
        emit({ status: "binding_activated", computerId: context.identity.computerId, harness });
        return saved;
    }

    /** Waits until the Machine's Runtime is online and offers the harness this run set up. */
    async function waitForReadiness(context: Context, runtime: RuntimeSelection, requestedHarness: string) {
        const harness = identifier(requestedHarness);
        let attempts = 0;
        while (true) {
            signal.throwIfAborted();
            const configuration = await request(
                context,
                `/chat/computers/${context.identity.computerId}/workspace`,
                {},
            );
            if (hasOnlineRuntimeAgent(object(configuration["runtime"]), runtime.computerId, harness)) {
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
        workingDirectory: string,
        identity: SetupIdentity["project"],
    ) {
        await waitForReadiness(context, runtime, options.harness);
        const transfer = await request(context, "/identity/transfers", {
            operationId: crypto.randomUUID(),
            ...(options.deviceAccess === null ? {} : { accessDuration: options.deviceAccess }),
        });
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
        const project: ProjectOutcome = context.identity.replacement.kind === "revoked" ? "replaced" : identity;
        emit({
            status: "ready",
            computerId: context.identity.computerId,
            url: handoffUrl,
            // The browser that opens the link keeps access until then, unless access is revoked earlier.
            accessExpiresAt: text(transfer["accessExpiresAt"]),
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
            await commit(context, withReplacementReported(context.identity));
        }
    }

    async function revokeAllAccess(options: RevokeAllAccessOptions) {
        const directory = await prepareStateDirectory(
            mortyStateDirectory({ ...process.env, MORTY_STATE_DIRECTORY: host.state }),
        );
        const saved = await readSavedState(directory);
        if (saved === null || saved.identity.kind !== "ready") {
            return fail("LOCAL_IDENTITY_REQUIRED");
        }
        // Never send the saved identity to a different origin, even when explicitly requested.
        if (options.base !== undefined && options.base !== saved.base) {
            throw new SavedIdentityOriginError(saved.base, options.base);
        }
        const revoked = await revokeAllAccessWithRotation(
            await retireReplacedIdentity({ directory, base: saved.base, identity: saved.identity }),
        );
        emit({
            status: "access_revoked",
            computerId: revoked.identity.computerId,
            message:
                "Previous sharing links and all other Morty credentials have been revoked, and chat windows opened with them have been closed. This computer's own credential was replaced, so copies of it no longer work.",
        });
    }

    async function preflightRuntime(directory: string, cwd: string) {
        progress("preflight", "Verifying the Morty CLI before creating an identity.");
        const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
        if (!((major === 22 && minor >= 19) || (major === 24 && minor >= 20))) {
            throw new RuntimePreflightError(
                `Node.js 22.19+ or 24.20+ is required; found ${process.versions.node} at ${process.execPath}.`,
            );
        }
        try {
            // This uses the same executable resolution as start/pair, including the Node
            // selected by its launcher. A package's engines field is not proof it starts.
            await runMorty(directory, ["--version"], cwd, AbortSignal.any([signal, deadline(120_000)]));
        } catch (cause) {
            signal.throwIfAborted();
            // The installation is fine; the shell names the wrong state root.
            if (cause instanceof MortyStateRootError) {
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
        const directory = await prepareStateDirectory(
            mortyStateDirectory({ ...process.env, MORTY_STATE_DIRECTORY: host.state }),
        );
        const location: StateLocation = { directory, base: options.base };
        // Refuses a state that belongs to another service before anything runs, and explains a previous replacement
        // even when this run fails its local startup checks.
        restoreReplacementAccess(await loadIdentity(directory, options.base));
        await preflightRuntime(directory, cwd);
        const saved = await loadIdentity(directory, options.base);
        restoreReplacementAccess(saved);
        const identity = await prepareIdentity(location, saved);
        const verified = await verifyIdentityAndMachine(
            await retireReplacedIdentity(await settleCredentialRotation(identity.context)),
        );
        let machine = verified.context;
        emit({ status: "identity_ready", userId: machine.identity.userId, computerId: machine.identity.computerId });
        const prepared = await prepareRuntime(machine, cwd, verified.runtimePairing, options.replaceProject);
        machine = prepared.context;
        await startRuntime(machine, prepared.runtime, cwd, options.harness);
        await waitForRuntime(machine, prepared.runtime, options.harness, cwd);
        machine = await bindAgent(machine, prepared.runtime, options.harness);
        await finishSetup(machine, prepared.runtime, options, cwd, identity.project);
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
                ...(cause instanceof MortyStateRootError
                    ? { runtime: cause.diagnostic(replacementAccess) }
                    : cause instanceof RuntimeStartError || cause instanceof RuntimePreflightError
                      ? { runtime: cause.diagnostic() }
                      : {}),
                ...(cause instanceof AgentBindingError ? { binding: cause.diagnostic() } : {}),
                ...(cause instanceof HarnessUnavailableError ? { harness: cause.diagnostic() } : {}),
                ...(cause instanceof ProjectReplacementRequiredError ? { replacement: cause.diagnostic() } : {}),
                ...(cause instanceof SavedIdentityOriginError ? { savedIdentity: cause.diagnostic() } : {}),
                ...replacementFailure(replacementAccess),
            },
        });
        return 1;
    }
}
