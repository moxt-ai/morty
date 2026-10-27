import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as v from "valibot";
import { expect, test } from "vitest";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { ControlledSetupRuntime } from "../../e2e/infra/setup-daemon.ts";
import worker from "../src/application.ts";
import { createIdentityFixture } from "./support/identity-fixture.ts";

interface SetupModule {
    readonly runSetup: (
        args: readonly string[],
        host: {
            readonly state: string;
            readonly documents: string;
            readonly agentEnvironment?: Readonly<Record<string, string | undefined>>;
            readonly signal: AbortSignal;
            readonly runtime?: ControlledSetupRuntime;
            readonly clock?: {
                readonly now: () => Date;
                readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
            };
            readonly emit: (event: Readonly<Record<string, unknown>>) => void;
        },
    ) => Promise<number>;
}

function isSetupModule(value: unknown): value is SetupModule {
    return value !== null && typeof value === "object" && "runSetup" in value && typeof value.runSetup === "function";
}

// Setup has its own Node compilation environment; load its public entrypoint at
// runtime rather than typechecking it with the Worker's Cloudflare globals.
const setupModule: unknown = await import(new URL("../../setup/src/setup.ts", import.meta.url).href);
if (!isSetupModule(setupModule)) {
    throw new Error("Missing setup entrypoint");
}
const { runSetup } = setupModule;

test.each(["missing", "unlaunchable", "npm-missing", "npm-unlaunchable"] as const)(
    "Given a %s local dependency, When setup checks the Mobius executable, Then it fails before creating an identity and reports recovery instructions",
    async (failure) => {
        const directory = await mkdtemp(join(tmpdir(), "morty-setup-preflight-"));
        const state = join(directory, "state");
        const bin = join(directory, "bin");
        await mkdir(bin);
        const fixture = await createIdentityFixture({ listenOnLoopback: true });
        try {
            if (failure !== "missing") {
                const entry = join(bin, "broken.mjs");
                await writeFile(
                    entry,
                    failure === "unlaunchable"
                        ? "await using = ;"
                        : `import ${JSON.stringify(new URL("../../../third-party/mobius/packages/cli/src/cli/entrypoint.ts", import.meta.url).href)};`,
                );
                if (failure === "npm-unlaunchable") {
                    await writeFile(
                        join(bin, process.platform === "win32" ? "npm.cmd" : "npm"),
                        process.platform === "win32" ? "@exit /b 42\r\n" : `#!${process.execPath}\nprocess.exit(42);\n`,
                        { mode: 0o700 },
                    );
                }
                await writeFile(
                    join(bin, process.platform === "win32" ? "mobius.cmd" : "mobius"),
                    process.platform === "win32"
                        ? `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`
                        : `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(entry).href)};\n`,
                    { mode: 0o700 },
                );
            }
            let output = "";
            const child = spawn(
                process.execPath,
                [
                    fileURLToPath(new URL("../../setup/src/cli.ts", import.meta.url)),
                    "setup",
                    "--base-url",
                    fixture.origin,
                    "--cwd",
                    directory,
                    "--harness",
                    "codex",
                    "--session-id",
                    "preflight-test",
                ],
                {
                    env: {
                        ...process.env,
                        PATH: bin,
                        MOBIUS_STATE_DIRECTORY: join(directory, "mobius-state"),
                        MORTY_STATE_DIRECTORY: state,
                        DOCUMENT_DIR: directory,
                    },
                    stdio: ["ignore", "pipe", "pipe"],
                    signal: AbortSignal.timeout(20000),
                    windowsHide: true,
                },
            );
            child.stdout.on("data", (chunk: Buffer) => {
                output += chunk.toString();
            });
            child.stderr.on("data", (chunk: Buffer) => {
                output += chunk.toString();
            });
            const [code] = await once(child, "close");
            expect(code, output).toBe(1);
            expect(output).toContain('"code":"RUNTIME_PREFLIGHT_FAILED"');
            expect(output).toContain("nextStep");
            expect(output).not.toContain('"status":"identity_ready"');
            await expect(readFile(join(state, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            await fixture.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
    30000,
);

test("Given a local workspace and a private state directory, When setup creates its identity and the user cancels, Then credentials remain private and can be reused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-setup-filesystem-"));
    const documents = join(directory, "Documents");
    const state = join(directory, "state ' & workspace");
    const workspace = join(directory, "workspace with spaces & quotes '");
    await Promise.all([documents, workspace].map((path) => mkdir(path)));
    const fixture = await createIdentityFixture({ listenOnLoopback: true });
    const cancellation = new AbortController();
    const events: Readonly<Record<string, unknown>>[] = [];
    try {
        const code = await runSetup(
            [
                "setup",
                "--base-url",
                fixture.origin,
                "--cwd",
                workspace,
                "--harness",
                "codex",
                "--session-id",
                "native-setup",
            ],
            {
                state,
                documents,
                agentEnvironment: {},
                signal: cancellation.signal,
                emit: (event) => {
                    events.push(event);
                    if (event["status"] === "identity_ready") {
                        cancellation.abort(new Error("User cancelled setup"));
                    }
                },
            },
        );
        expect(code).toBe(1);
        expect(events).toContainEqual(expect.objectContaining({ status: "identity_ready" }));
        expect(events.at(-1)).toMatchObject({ error: { code: "CANCELLED" } });
        const configPath = join(state, "config.json");
        const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
        expect(config).toMatchObject({
            base_url: fixture.origin,
            user_token: expect.stringMatching(/^mobius_anon_v2_/u),
        });
        if (process.platform === "win32") {
            const execute = promisify(execFile);
            const { stdout } = await execute(
                "powershell.exe",
                [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1'); $a = Get-Acl -LiteralPath $env:MORTY_TEST_CONFIG; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; if (-not $a.AreAccessRulesProtected) { exit 1 }; if (@($a.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]) -ne $sid }).Count -gt 0) { exit 2 }; 'private'",
                ],
                {
                    env: { ...process.env, MORTY_TEST_CONFIG: configPath },
                    windowsHide: true,
                    signal: AbortSignal.timeout(10000),
                    timeout: 10000,
                },
            );
            expect(stdout.trim()).toBe("private");
        } else {
            expect((await stat(configPath)).mode & 0o777).toBe(0o600);
        }
    } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
}, 30000);

test("Given a junction replaces the private Morty directory, When setup validates its local state, Then it refuses to write credentials through the link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-setup-link-"));
    const documents = join(directory, "Documents");
    const state = join(directory, "state");
    const target = join(directory, "target");
    await Promise.all([documents, target].map((path) => mkdir(path)));
    await symlink(target, state, process.platform === "win32" ? "junction" : "dir");
    const events: Readonly<Record<string, unknown>>[] = [];
    try {
        expect(
            await runSetup(
                [
                    "setup",
                    "--base-url",
                    "http://127.0.0.1:1",
                    "--cwd",
                    directory,
                    "--harness",
                    "codex",
                    "--session-id",
                    "native-setup",
                ],
                {
                    state,
                    documents,
                    agentEnvironment: {},
                    signal: new AbortController().signal,
                    emit: (event) => events.push(event),
                },
            ),
        ).toBe(1);
        expect(events.at(-1)).toMatchObject({ error: { code: "UNSAFE_CONFIG_PATH" } });
        await expect(stat(join(target, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test.runIf(process.platform !== "win32")(
    "Given HOME and no overrides, When a user runs the setup CLI, Then identity is saved in the platform's local state directory, not Documents, and cancellation releases setup",
    { timeout: 30000 },
    async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-setup-home-"));
        const documents = join(directory, "Documents");
        const state =
            process.platform === "darwin"
                ? join(directory, "Library", "Application Support", "Morty")
                : join(directory, ".local", "state", "morty");
        const workspace = join(directory, "workspace");
        await Promise.all([documents, workspace].map((path) => mkdir(path)));
        const fixture = await createIdentityFixture({ listenOnLoopback: true });
        const environment = Object.fromEntries(
            Object.entries(process.env).filter(
                ([name]) => !["DOCUMENT_DIR", "MORTY_STATE_DIRECTORY", "XDG_STATE_HOME"].includes(name),
            ),
        );
        const child = spawn(
            process.execPath,
            [
                fileURLToPath(new URL("../../setup/src/cli.ts", import.meta.url)),
                "setup",
                "--base-url",
                fixture.origin,
                "--cwd",
                workspace,
                "--harness",
                "codex",
                "--session-id",
                "xdg-current-session",
            ],
            {
                env: { ...environment, HOME: directory },
                stdio: ["ignore", "pipe", "pipe"],
                signal: AbortSignal.timeout(30000),
            },
        );
        const exited = once(child, "exit");
        let output = "";
        let cancellationRequested = false;
        child.stdout.on("data", (chunk) => {
            output += chunk.toString();
            if (!cancellationRequested && output.includes('"status":"identity_ready"')) {
                cancellationRequested = true;
                child.kill("SIGINT");
            }
        });
        child.stderr.resume();
        try {
            const [code] = await exited;
            expect(code, output).toBe(1);
            expect(output).toContain('"status":"identity_ready"');
            const saved: unknown = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
            expect(saved).toMatchObject({ base_url: fixture.origin });
            expect((await stat(state)).mode & 0o777).toBe(0o700);
            await expect(stat(join(documents, "morty"))).rejects.toMatchObject({ code: "ENOENT" });
            expect(output).toContain('"code":"CANCELLED"');
        } finally {
            child.kill();
            await fixture.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
);

const starterFailures = [
    ["exit", "When its starter fails by exit, Then setup reports actionable diagnostics and bounds recovery"],
    ["signal", "When its starter fails by signal, Then setup reports actionable diagnostics and bounds recovery"],
    [
        "cancel",
        "When its starter fails and setup is cancelled during recovery, Then setup reports actionable diagnostics and bounds recovery",
    ],
    ["recover", "When its starter fails by recover, Then setup reports actionable diagnostics and bounds recovery"],
    [
        "cancel-upgrade",
        "When setup is cancelled while the daemon upgrade downloads, Then the upgrade stops the processes it started",
    ],
    ["stuck-start", "When setup is cancelled while its starter ignores SIGTERM, Then setup still stops the starter"],
] as const;

for (const [failure, scenario] of starterFailures) {
    test.runIf(process.platform !== "win32")(
        `Given an offline managed Runtime, ${scenario}`,
        async () => {
            const directory = await mkdtemp(join(tmpdir(), "morty-setup-start-"));
            const state = join(directory, "state");
            const bin = join(directory, "bin");
            await Promise.all([mkdir(state, { recursive: true }), mkdir(bin)]);
            const fixture = await createIdentityFixture({ listenOnLoopback: true });
            try {
                const identity = await fixture.createAnonymousUser();
                const runtime = await fixture.connectAgent(identity.projectId);
                const request = async (path: string, body?: object) => {
                    const response = await fetch(`${fixture.origin}/morty/api/${path}`, {
                        method: body === undefined ? "GET" : "POST",
                        headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" },
                        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                        signal: AbortSignal.timeout(10000),
                    });
                    expect(response.ok).toBe(true);
                    return await response.json();
                };
                const bots = v.parse(
                    v.object({ bots: v.array(v.object({ botId: v.string() })) }),
                    await request(`projects/${identity.projectId}/management/bots`),
                );
                const botId = v.parse(v.string(), bots.bots[0]?.botId);
                await request(`chat/projects/${identity.projectId}/bots/${botId}/setup`, {
                    runtimeId: runtime.runtimeId,
                    agentRef: "codex",
                });
                await runtime.disconnect();
                const connection = {
                    app_id: fixture.baseConfiguration.MOBIUS_APP_ID,
                    runtime_id: runtime.runtimeId,
                    connection_id: "managed-test-connection",
                };
                await writeFile(
                    join(state, "config.json"),
                    JSON.stringify({
                        base_url: fixture.origin,
                        user_token: identity.token,
                        user_id: identity.userId,
                        project_id: identity.projectId,
                        bot_id: botId,
                        agent_ref: "codex",
                        agent_config_revision: 1,
                        workspace: directory,
                        entry: "setup",
                    }),
                    { mode: 0o600 },
                );
                await writeFile(join(directory, "connections.json"), JSON.stringify([connection]));
                await writeFile(join(directory, "attempts.txt"), "0");
                await writeFile(
                    join(bin, "mobius"),
                    `#!${process.execPath}
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const output = process.argv.find(arg => arg.startsWith('--output-json='));
if (process.argv[2] === '--version') { process.exit(0); }
if (process.argv[2] === 'upgrade') {
    ${
        failure === "cancel-upgrade"
            ? `// Like npm downloading a release: a child the CLI stops when it is asked to stop.
    const download = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync('download.pid', String(download.pid));
    process.on('SIGTERM', () => { download.kill('SIGTERM'); process.exit(143); });
    process.kill(process.ppid, 'SIGUSR2');
    setInterval(() => {}, 1000);`
            : "// The daemon already runs the newest release, so an upgrade has nothing to do.\n    process.exit(0);"
    }
} else if (output) { writeFileSync(output.slice('--output-json='.length), readFileSync('connections.json')); }
else if (${JSON.stringify(failure === "stuck-start")}) {
    // A starter that ignores the request to stop and never exits on its own.
    process.on('SIGTERM', () => {});
    writeFileSync('starter.pid', String(process.pid));
    process.kill(process.ppid, 'SIGUSR2');
    setInterval(() => {}, 1000);
} else {
    const attempts = Number(readFileSync('attempts.txt', 'utf8')) + 1;
    writeFileSync('attempts.txt', String(attempts));
    ${failure === "signal" ? "process.kill(process.pid, 'SIGTERM');" : failure === "recover" ? "process.exit(attempts === 1 ? 42 : 0);" : failure === "cancel-upgrade" ? "process.exit(0);" : "process.exit(42);"}
}
`,
                    { mode: 0o700 },
                );
                const runner = join(directory, "run.mjs");
                await writeFile(
                    runner,
                    `import { runSetup } from ${JSON.stringify(new URL("../../setup/src/setup.ts", import.meta.url).href)};
const cancellation = new AbortController();
process.on('SIGUSR2', () => cancellation.abort());
let time = Date.parse('2026-09-15T12:00:00Z');
process.exitCode = await runSetup(process.argv.slice(2), {
    state: process.env.MORTY_STATE_DIRECTORY, documents: process.env.DOCUMENT_DIR, signal: cancellation.signal,
    emit(event) { console.log(JSON.stringify(event)); ${failure === "cancel" ? "if (event.status === 'runtime_retrying') cancellation.abort();" : ""} },
    clock: { now: () => new Date(time), wait: async (milliseconds, signal) => { signal.throwIfAborted(); time += milliseconds; } },
});
`,
                );
                const child = spawn(
                    process.execPath,
                    [
                        runner,
                        "setup",
                        "--base-url",
                        fixture.origin,
                        "--cwd",
                        directory,
                        "--harness",
                        "codex",
                        "--session-id",
                        "native-start",
                    ],
                    {
                        env: {
                            ...process.env,
                            MORTY_STATE_DIRECTORY: state,
                            DOCUMENT_DIR: join(directory, "Documents"),
                            PATH: `${bin}:${process.env["PATH"] ?? ""}`,
                        },
                        stdio: ["ignore", "pipe", "pipe"],
                        signal: AbortSignal.timeout(30000),
                    },
                );
                const exited = once(child, "exit");
                let output = "";
                let recovery: Promise<void> | undefined;
                child.stdout.on("data", (chunk) => {
                    output += chunk.toString();
                    // The started daemon comes online, so setup proceeds to the upgrade or the handoff.
                    if (
                        (failure === "recover" || failure === "cancel-upgrade") &&
                        recovery === undefined &&
                        output.includes('"status":"runtime_started"')
                    ) {
                        recovery = runtime.reconnect();
                        void recovery.catch(() => child.kill());
                    }
                });
                child.stderr.on("data", (chunk) => {
                    output += chunk.toString();
                });
                const [code] = await exited;
                await recovery;
                expect(code, output).toBe(failure === "recover" ? 0 : 1);
                const events = output
                    .trim()
                    .split("\n")
                    .map((line) => v.parse(v.record(v.string(), v.unknown()), JSON.parse(line)));
                if (failure === "cancel-upgrade" || failure === "stuck-start") {
                    expect(events.at(-1)).toMatchObject({ error: { code: "CANCELLED" } });
                    const download = Number(
                        await readFile(
                            join(directory, failure === "stuck-start" ? "starter.pid" : "download.pid"),
                            "utf8",
                        ),
                    );
                    let running = true;
                    try {
                        process.kill(download, 0);
                    } catch {
                        running = false;
                    }
                    if (running) {
                        process.kill(download, "SIGKILL");
                    }
                    expect(
                        running,
                        `the ${failure === "stuck-start" ? "starter" : "upgrade download"} outlived setup`,
                    ).toBe(false);
                    return;
                }
                const retries = events.filter((event) => event["status"] === "runtime_retrying");
                expect(retries, output).toHaveLength(failure === "cancel" || failure === "recover" ? 1 : 2);
                if (failure === "recover") {
                    expect(events.at(-1)).toMatchObject({ status: "ready" });
                    expect(events).toContainEqual(expect.objectContaining({ status: "runtime_online" }));
                    return;
                }
                expect(events.at(-1)).toMatchObject({
                    error: { code: failure === "cancel" ? "CANCELLED" : "RUNTIME_START_FAILED" },
                });
                const lastError = v.parse(v.object({ runtime: v.optional(v.unknown()) }), events.at(-1)?.["error"]);
                const diagnostic = v.parse(
                    v.object({ logPath: v.string(), termination: v.unknown(), nextStep: v.string() }),
                    failure === "cancel" ? retries[0]?.["failure"] : lastError.runtime,
                );
                expect(diagnostic).toMatchObject({
                    termination:
                        failure === "signal" ? { kind: "signal", signal: "SIGTERM" } : { kind: "exit", exitCode: 42 },
                    logPath: expect.stringMatching(/runtime-.*\.log$/u),
                    nextStep: expect.stringContaining("mobius"),
                });
                expect(await readFile(diagnostic.logPath, "utf8")).toContain(failure === "signal" ? "SIGTERM" : "42");
            } finally {
                await fixture.close();
                await rm(directory, { recursive: true, force: true });
            }
        },
        30000,
    );
}

test.runIf(process.env["MORTY_VERIFY_SYSTEM_STATE"] === "true" && process.platform === "darwin")(
    "Given MORTY_STATE_DIRECTORY is unset on macOS, When setup connects and the user cancels, Then the private identity is saved under ~/Library/Application Support/Morty",
    async () => {
        if (process.env["CI"] !== "true" || process.env["MORTY_STATE_DIRECTORY"] !== undefined) {
            throw new Error("System state verification requires an isolated CI runner without MORTY_STATE_DIRECTORY");
        }
        const configuration = join(homedir(), "Library", "Application Support", "Morty");
        try {
            await stat(configuration);
            throw new Error("Refusing to overwrite existing Morty configuration");
        } catch (cause) {
            if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
                throw cause;
            }
        }
        const workspace = await mkdtemp(join(tmpdir(), "morty-macos-workspace-"));
        const fixture = await createIdentityFixture({ listenOnLoopback: true });
        const cancellation = new AbortController();
        const events: Readonly<Record<string, unknown>>[] = [];
        try {
            const code = await runSetup(
                [
                    "setup",
                    "--base-url",
                    fixture.origin,
                    "--cwd",
                    workspace,
                    "--harness",
                    "codex",
                    "--session-id",
                    "macos-current-session",
                ],
                {
                    state: "",
                    documents: "",
                    agentEnvironment: {},
                    signal: cancellation.signal,
                    emit: (event) => {
                        events.push(event);
                        if (event["status"] === "identity_ready") {
                            cancellation.abort();
                        }
                    },
                },
            );
            expect(code).toBe(1);
            expect(events).toContainEqual(expect.objectContaining({ status: "identity_ready" }));
            expect(events.at(-1)).toMatchObject({ error: { code: "CANCELLED" } });
            const saved: unknown = JSON.parse(await readFile(join(configuration, "config.json"), "utf8"));
            expect(saved).toMatchObject({ base_url: fixture.origin });
            expect((await stat(join(configuration, "config.json"))).mode & 0o777).toBe(0o600);
        } finally {
            await fixture.close();
            await rm(configuration, { recursive: true, force: true });
            await rm(workspace, { recursive: true, force: true });
        }
    },
);

for (const segments of [4, 8]) {
    test.skipIf(segments === 8 && process.platform !== "linux")(
        `Given a valid ${segments}-segment multibyte workspace, When setup prepares the handoff, Then it delivers the normal link even when no QR can represent it`,
        { timeout: 30_000 },
        async () => {
            const root = await realpath(await mkdtemp(join(tmpdir(), "morty-setup-long-")));
            const documents = join(root, "Documents");
            const state = join(root, "state");
            const workspace = join(
                root,
                ...Array.from({ length: segments }, () => "\u00e9".repeat(segments === 8 ? 110 : 90)),
            );
            await mkdir(workspace, { recursive: true });
            const fixture = await createIdentityFixture({ listenOnLoopback: true });
            const runtime = new ControlledSetupRuntime(
                { agentId: "codex", agentName: "Codex", reply: mortyReply },
                "Setup test Runtime",
            );
            const events: Readonly<Record<string, unknown>>[] = [];
            let time = Date.parse("2026-09-15T12:00:00Z");
            try {
                const code = await runSetup(
                    [
                        "setup",
                        "--base-url",
                        fixture.origin,
                        "--cwd",
                        workspace,
                        "--harness",
                        "codex",
                        "--session-id",
                        "native-long-project",
                    ],
                    {
                        state,
                        documents,
                        agentEnvironment: {},
                        signal: AbortSignal.timeout(25_000),
                        runtime,
                        emit: (event) => events.push(event),
                        clock: {
                            now: () => new Date(time),
                            wait: async (milliseconds, signal) => {
                                signal.throwIfAborted();
                                time += milliseconds;
                            },
                        },
                    },
                );
                expect(code, JSON.stringify(events)).toBe(0);
                const ready = events.at(-1);
                expect(ready).toMatchObject({ status: "ready", workspace });
                const link = ready?.["url"];
                if (typeof link !== "string") {
                    throw new Error("Missing setup link");
                }
                expect(new URL(link).searchParams.get("workspace")).toBe(workspace);
                if (segments === 8) {
                    expect(ready).toMatchObject({ qrPath: null });
                    expect(events).toContainEqual(
                        expect.objectContaining({
                            status: "qr_unavailable",
                            error: expect.objectContaining({ code: "QR_UNAVAILABLE" }),
                        }),
                    );
                }
            } finally {
                await runtime.disconnect();
                await fixture.close();
                const qrPath = events.at(-1)?.["qrPath"];
                if (typeof qrPath === "string") {
                    await rm(qrPath, { force: true });
                }
                await rm(root, { recursive: true, force: true });
            }
        },
    );
}

async function setupMachine(
    runtime: ControlledSetupRuntime,
    paths: {
        readonly origin: string;
        readonly documents: string;
        readonly state: string;
        readonly workspace: string;
    },
    deadline?: (milliseconds: number) => AbortSignal,
    run: {
        readonly harness?: string;
        /** The `--session-id` the agent passes; `null` passes none. */
        readonly sessionArgument?: string | null;
        /** The calling agent's shell environment, where a harness exposes its current session. */
        readonly agentEnvironment?: Readonly<Record<string, string>>;
        /** The user stops setup as soon as it reports this status. */
        readonly interruptAt?: string;
        /** Runs before setup's clock moves on, with every event setup reported so far. */
        readonly whileWaiting?: (events: readonly Readonly<Record<string, unknown>>[]) => Promise<void>;
        /** From this progress stage on, the network stalls and every deadline setup starts has already passed. */
        readonly stallFromStage?: string;
    } = {},
): Promise<{ readonly code: number; readonly events: readonly Readonly<Record<string, unknown>>[] }> {
    const events: Readonly<Record<string, unknown>>[] = [];
    let time = Date.parse("2026-10-22T12:00:00Z");
    const interrupt = new AbortController();
    const code = await runSetup(
        [
            "setup",
            "--base-url",
            paths.origin,
            "--cwd",
            paths.workspace,
            "--harness",
            run.harness ?? "settings-test",
            ...(run.sessionArgument === null ? [] : ["--session-id", run.sessionArgument ?? "native-upgrade-project"]),
        ],
        {
            state: paths.state,
            documents: paths.documents,
            agentEnvironment: run.agentEnvironment ?? {},
            signal: AbortSignal.any([interrupt.signal, AbortSignal.timeout(55_000)]),
            runtime,
            emit: (event) => {
                events.push(event);
                if (run.interruptAt !== undefined && event["status"] === run.interruptAt) {
                    interrupt.abort(new Error("The user stopped setup."));
                }
            },
            clock: {
                now: () => new Date(time),
                wait: async (milliseconds, signal) => {
                    signal.throwIfAborted();
                    await run.whileWaiting?.(events);
                    time += milliseconds;
                },
                ...(deadline === undefined && run.stallFromStage === undefined
                    ? {}
                    : {
                          deadline: (milliseconds: number) =>
                              run.stallFromStage !== undefined &&
                              events.some((event) => event["stage"] === run.stallFromStage)
                                  ? AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"))
                                  : (deadline ?? AbortSignal.timeout)(milliseconds),
                      }),
            },
        },
    );
    const qrPath = events.at(-1)?.["qrPath"];
    if (typeof qrPath === "string") {
        await rm(qrPath, { force: true });
    }
    return { code, events };
}

/** Setup's daemon upgrade budget. */
const upgradeBudgetMilliseconds = 180_000;

/** Lets a scenario end setup's upgrade budget early; every other deadline keeps its own time. */
function upgradeBudget() {
    const budget = new AbortController();
    return {
        deadline: (milliseconds: number) =>
            milliseconds === upgradeBudgetMilliseconds ? budget.signal : AbortSignal.timeout(milliseconds),
        elapse: () => budget.abort(new DOMException("The upgrade budget elapsed", "TimeoutError")),
    };
}

async function withUpgradeMachine(
    upgrade: ConstructorParameters<typeof ControlledSetupRuntime>[2],
    scenario: (
        runtime: ControlledSetupRuntime,
        paths: {
            readonly origin: string;
            readonly documents: string;
            readonly state: string;
            readonly workspace: string;
        },
    ) => Promise<void>,
    /** The daemon release the machine runs before setup. Only the current release can run Agents other than settings. */
    release: "previous" | "current" = "previous",
): Promise<void> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "morty-setup-upgrade-")));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const fixture = await createIdentityFixture({ listenOnLoopback: true });
    const runtime = new ControlledSetupRuntime(
        { agentId: "settings-test", agentName: "Settings Agent", reply: mortyReply, runtime: release },
        "Setup test Runtime",
        upgrade,
    );
    try {
        await scenario(runtime, {
            origin: fixture.origin,
            documents: join(root, "Documents"),
            state: join(root, "state"),
            workspace,
        });
    } finally {
        await runtime.disconnect();
        await fixture.close();
        await rm(root, { recursive: true, force: true });
    }
}

test("Given a paired machine whose online daemon runs a previous release, When the user reruns setup and an upgrade is available, Then setup reuses the Runtime on the newest release", {
    timeout: 90_000,
}, async () => {
    await withUpgradeMachine("unavailable", async (runtime, paths) => {
        const first = await setupMachine(runtime, paths);
        expect(first.code, JSON.stringify(first.events)).toBe(0);
        expect(runtime.daemonRelease()).toBe("previous");

        runtime.setUpgrade("available");
        const rerun = await setupMachine(runtime, paths);
        expect(rerun.code, JSON.stringify(rerun.events)).toBe(0);
        expect(rerun.events).toContainEqual(expect.objectContaining({ status: "runtime_already_online" }));
        expect(rerun.events.at(-1)).toMatchObject({ status: "ready", workspace: paths.workspace });
        expect(runtime.daemonRelease()).toBe("current");
    });
});

test("Given setup was stopped after pairing its Runtime, When the user runs setup again and again, Then each run continues on that Runtime and setup finishes", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine("unavailable", async (runtime, paths) => {
        // A Project holds at most eight Runtimes; each stopped run must not leave another one behind.
        for (let attempt = 1; attempt <= 8; attempt += 1) {
            const stopped = await setupMachine(runtime, paths, undefined, { interruptAt: "runtime_paired" });
            expect(stopped.code, JSON.stringify(stopped.events)).not.toBe(0);
        }
        const finished = await setupMachine(runtime, paths);
        expect(finished.code, JSON.stringify(finished.events)).toBe(0);
        expect(finished.events.at(-1)).toMatchObject({ status: "ready", workspace: paths.workspace });
    });
});

test("Given setup replaced the Project and was stopped before it finished, When the user runs setup again, Then the finished setup still reports the replacement once", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine("unavailable", async (runtime, paths) => {
        const first = await setupMachine(runtime, paths);
        expect(first.events.at(-1)).toMatchObject({ status: "ready", project: "created" });
        await runtime.forgetConnections();

        const stopped = await setupMachine(runtime, paths, undefined, { interruptAt: "project_replaced" });
        expect(stopped.code, JSON.stringify(stopped.events)).not.toBe(0);
        expect(stopped.events).not.toContainEqual(expect.objectContaining({ status: "ready" }));

        const finished = await setupMachine(runtime, paths);
        expect(finished.code, JSON.stringify(finished.events)).toBe(0);
        expect(finished.events.at(-1)).toMatchObject({ status: "ready", project: "replaced" });

        const again = await setupMachine(runtime, paths);
        expect(again.events.at(-1)).toMatchObject({ status: "ready", project: "reused" });
    });
});

test("Given the agent's shell exposes its current Pi session, When setup runs without --session-id, Then the link continues that session", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine(
        "unavailable",
        async (runtime, paths) => {
            await runtime.installAgents({
                agentId: "pi",
                agentName: "Pi",
                additionalAgents: [{ id: "settings-test", name: "Settings Agent" }],
            });
            const finished = await setupMachine(runtime, paths, undefined, {
                harness: "pi",
                sessionArgument: null,
                agentEnvironment: { PI_SESSION_ID: "pi-shell-session" },
            });
            expect(finished.code, JSON.stringify(finished.events)).toBe(0);
            const ready = finished.events.at(-1);
            expect(ready).toMatchObject({ status: "ready" });
            expect(new URL(String(ready?.["url"])).searchParams.get("sessionId")).toBe("pi-shell-session");
        },
        "current",
    );
});

test("Given an agent passes a session ID its shell does not expose, When setup runs, Then the link continues the shell's session and setup reports the mismatch", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine(
        "unavailable",
        async (runtime, paths) => {
            await runtime.installAgents({
                agentId: "pi",
                agentName: "Pi",
                additionalAgents: [{ id: "settings-test", name: "Settings Agent" }],
            });
            const finished = await setupMachine(runtime, paths, undefined, {
                harness: "pi",
                sessionArgument: "agent-guessed-session",
                agentEnvironment: { PI_SESSION_ID: "pi-shell-session" },
            });
            expect(finished.code, JSON.stringify(finished.events)).toBe(0);
            expect(finished.events).toContainEqual(
                expect.objectContaining({ status: "session_id_mismatch", harness: "pi", variable: "PI_SESSION_ID" }),
            );
            expect(new URL(String(finished.events.at(-1)?.["url"])).searchParams.get("sessionId")).toBe(
                "pi-shell-session",
            );
        },
        "current",
    );
});

test("Given neither the agent's shell nor its arguments name a session, When setup runs, Then it fails before creating an identity and names the variable it looked for", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine(
        "unavailable",
        async (runtime, paths) => {
            const failed = await setupMachine(runtime, paths, undefined, {
                harness: "pi",
                sessionArgument: null,
                agentEnvironment: { CLAUDE_CODE_SESSION_ID: "an-outer-claude-session" },
            });
            expect(failed.code, JSON.stringify(failed.events)).not.toBe(0);
            expect(failed.events).toContainEqual(
                expect.objectContaining({ status: "session_unavailable", harness: "pi", variable: "PI_SESSION_ID" }),
            );
            expect(failed.events.at(-1)).toMatchObject({ error: { code: "SESSION_ID_REQUIRED" } });
            expect(failed.events).not.toContainEqual(expect.objectContaining({ status: "identity_ready" }));
        },
        "current",
    );
});

test("Given the chosen harness is not installed, When the user reruns setup with it, Then each run reports it unavailable and setup finishes once an installed harness is chosen", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine("unavailable", async (runtime, paths) => {
        for (let attempt = 1; attempt <= 8; attempt += 1) {
            const failed = await setupMachine(runtime, paths, undefined, { harness: "pi" });
            expect(failed.code, JSON.stringify(failed.events)).not.toBe(0);
            expect(failed.events).toContainEqual(
                expect.objectContaining({ status: "harness_unavailable", harness: "pi", available: ["settings-test"] }),
            );
            // This machine's Mobius cannot report why, so setup still names a next step without guessing a cause.
            expect(failed.events.at(-1)?.["error"]).toMatchObject({
                code: "HARNESS_UNAVAILABLE",
                harness: {
                    harness: "pi",
                    status: "unknown",
                    nextStep: expect.stringContaining("Confirm `pi` starts and answers a prompt in a new terminal"),
                },
            });
        }
        const finished = await setupMachine(runtime, paths);
        expect(finished.code, JSON.stringify(finished.events)).toBe(0);
        expect(finished.events.at(-1)).toMatchObject({ status: "ready", workspace: paths.workspace });
    });
});

function machineOf(events: readonly Readonly<Record<string, unknown>>[]) {
    return events.find((event) => event["status"] === "identity_ready")?.["botId"];
}

test("Given the chosen agent is installed but signed out, When setup connects it, Then setup asks the user to sign in and finishes on the same Machine afterwards", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine(
        "unavailable",
        async (runtime, paths) => {
            await runtime.installAgents({ agentId: "signed-out-test", agentName: "Signed-out Agent" });
            const failed = await setupMachine(runtime, paths, undefined, { harness: "signed-out-test" });
            expect(failed.code, JSON.stringify(failed.events)).not.toBe(0);
            expect(failed.events.at(-1)?.["error"]).toMatchObject({
                code: "authentication_required",
                binding: {
                    harness: "signed-out-test",
                    nextStep: expect.stringContaining(
                        "Ask the user to sign in to signed-out-test on this computer; you cannot sign in for them.",
                    ),
                },
            });

            // The user signs in, so the same harness now opens sessions.
            await runtime.installAgents({ agentId: "settings-test", agentName: "Settings Agent" });
            const finished = await setupMachine(runtime, paths, undefined, { harness: "settings-test" });
            expect(finished.code, JSON.stringify(finished.events)).toBe(0);
            expect(machineOf(finished.events)).toBe(machineOf(failed.events));
            expect(finished.events.at(-1)).toMatchObject({ status: "ready", project: "reused" });
        },
        "current",
    );
});

test("Given the network stalls while setup connects the agent, When the request times out, Then setup tells the agent to rerun unchanged and the rerun finishes on the same Machine", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine("unavailable", async (runtime, paths) => {
        const failed = await setupMachine(runtime, paths, undefined, { stallFromStage: "binding" });
        expect(failed.code, JSON.stringify(failed.events)).not.toBe(0);
        const failure = failed.events.at(-1)?.["error"];
        expect(failure).toMatchObject({
            code: "TIMEOUT",
            binding: {
                harness: "settings-test",
                nextStep: expect.stringContaining("Rerun setup without changing anything"),
            },
        });
        expect(JSON.stringify(failure)).not.toContain("sign in");

        const finished = await setupMachine(runtime, paths);
        expect(finished.code, JSON.stringify(finished.events)).toBe(0);
        expect(machineOf(finished.events)).toBe(machineOf(failed.events));
        expect(finished.events.at(-1)).toMatchObject({ status: "ready", project: "reused" });
    });
});

test("Given the chosen agent cannot open a session for another reason, When setup connects it, Then setup asks the agent to check the harness instead of guessing a fix", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine(
        "unavailable",
        async (runtime, paths) => {
            await runtime.installAgents({ agentId: "broken-test", agentName: "Broken Agent" });
            const failed = await setupMachine(runtime, paths, undefined, { harness: "broken-test" });
            expect(failed.code, JSON.stringify(failed.events)).not.toBe(0);
            const failure = failed.events.at(-1)?.["error"];
            expect(failure).toMatchObject({
                binding: {
                    harness: "broken-test",
                    nextStep: expect.stringContaining("Confirm broken-test answers a prompt in the working directory"),
                },
            });
            expect(failure).not.toMatchObject({ code: "SETUP_FAILED" });
            expect(JSON.stringify(failure)).not.toMatch(/sign in|update/u);
        },
        "current",
    );
});

test("Given Pi is installed but signed out, so the Runtime does not offer it, When setup runs with Pi, Then setup asks the user to sign in with Pi's own command and finishes on the same Machine afterwards", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine(
        "unavailable",
        async (runtime, paths) => {
            runtime.reportAgentInventory([
                {
                    id: "pi",
                    label: "Pi",
                    status: "authentication_required",
                    code: "authentication_required",
                    message: "Agent authentication is required",
                    recoveryCommand: "pi",
                },
            ]);
            const failed = await setupMachine(runtime, paths, undefined, { harness: "pi" });
            expect(failed.code, JSON.stringify(failed.events)).not.toBe(0);
            expect(failed.events.at(-1)?.["error"]).toMatchObject({
                code: "HARNESS_UNAVAILABLE",
                harness: {
                    harness: "pi",
                    status: "authentication_required",
                    nextStep: expect.stringContaining(
                        "Ask the user to sign in to Pi on this computer by running `pi` in a terminal; you cannot sign in for them.",
                    ),
                },
            });

            // The user signs in, so this computer's Mobius offers Pi again.
            runtime.reportAgentInventory([]);
            await runtime.installAgents({
                agentId: "pi",
                agentName: "Pi",
                additionalAgents: [{ id: "settings-test", name: "Settings Agent" }],
            });
            const finished = await setupMachine(runtime, paths, undefined, { harness: "pi" });
            expect(finished.code, JSON.stringify(finished.events)).toBe(0);
            expect(machineOf(finished.events)).toBe(machineOf(failed.events));
            expect(finished.events.at(-1)).toMatchObject({ status: "ready" });
        },
        "current",
    );
});

test("Given Pi became ready after the running Runtime published its Agents, When setup runs with Pi and the Runtime still omits it, Then setup asks to rerun once and to get the user's consent before restarting Mobius", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine(
        "unavailable",
        async (runtime, paths) => {
            runtime.reportAgentInventory([], [{ id: "pi", label: "Pi" }]);
            const failed = await setupMachine(runtime, paths, undefined, { harness: "pi" });
            expect(failed.code, JSON.stringify(failed.events)).not.toBe(0);
            const failure = failed.events.at(-1)?.["error"];
            expect(failure).toMatchObject({
                code: "HARNESS_UNAVAILABLE",
                harness: {
                    harness: "pi",
                    status: "ready",
                    nextStep: expect.stringContaining(
                        "ask the user before running `mobius quit`, because it stops every Morty session on this computer",
                    ),
                },
            });
            expect(JSON.stringify(failure)).toContain("Rerun setup once.");
        },
        "current",
    );
});

test("Given setup continues on a Runtime that does not offer the chosen harness yet, When the user installs it while setup waits, Then setup finishes once the Runtime publishes it", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine(
        "unavailable",
        async (runtime, paths) => {
            const missing = await setupMachine(runtime, paths, undefined, { harness: "pi" });
            expect(missing.code, JSON.stringify(missing.events)).not.toBe(0);

            // The Runtime is online with its earlier catalog until it republishes the newly installed harness.
            let installing: Promise<void> | null = null;
            const installed = await setupMachine(runtime, paths, undefined, {
                harness: "pi",
                whileWaiting: async (events) => {
                    if (events.some((event) => event["status"] === "runtime_reused") && installing === null) {
                        installing = runtime.installAgents({
                            agentId: "pi",
                            agentName: "Pi",
                            additionalAgents: [{ id: "settings-test", name: "Settings Agent" }],
                        });
                    }
                    await installing;
                },
            });
            expect(installed.code, JSON.stringify(installed.events)).toBe(0);
            expect(installed.events).toContainEqual(
                expect.objectContaining({ status: "runtime_online", harness: "pi" }),
            );
            expect(installed.events.at(-1)).toMatchObject({ status: "ready", workspace: paths.workspace });
        },
        "current",
    );
});

test("Given setup bound the Machine but never received the reply, When the user runs setup again, Then setup finishes on the bound Runtime", {
    timeout: 90_000,
}, async () => {
    await withUpgradeMachine("unavailable", async (runtime, paths) => {
        const first = await setupMachine(runtime, paths);
        expect(first.code, JSON.stringify(first.events)).toBe(0);
        // The Worker committed the binding, but the run stopped before it saved the binding locally, as when the
        // reply is lost to an interruption, a dropped connection or the request deadline.
        const configPath = join(paths.state, "config.json");
        const saved: Record<string, unknown> = {
            ...v.parse(v.record(v.string(), v.unknown()), JSON.parse(await readFile(configPath, "utf8"))),
        };
        delete saved["agent_ref"];
        delete saved["agent_config_revision"];
        await rm(configPath);
        await writeFile(configPath, JSON.stringify(saved), { mode: 0o600 });

        const rerun = await setupMachine(runtime, paths);
        expect(rerun.code, JSON.stringify(rerun.events)).toBe(0);
        expect(rerun.events).toContainEqual(expect.objectContaining({ status: "runtime_reused" }));
        expect(rerun.events.at(-1)).toMatchObject({ status: "ready", workspace: paths.workspace });
        expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ agent_ref: "settings-test" });
    });
});

test("Given a machine runs a previous daemon release and no upgrade is reachable, When setup prepares the Runtime, Then setup completes on the running release and reports why", {
    timeout: 60_000,
}, async () => {
    await withUpgradeMachine("unavailable", async (runtime, paths) => {
        const { code, events } = await setupMachine(runtime, paths);
        expect(code, JSON.stringify(events)).toBe(0);
        expect(events.at(-1)).toMatchObject({ status: "ready", workspace: paths.workspace });
        expect(runtime.daemonRelease()).toBe("previous");
        expect(events).toContainEqual(
            expect.objectContaining({
                status: "runtime_upgrade_skipped",
                error: expect.objectContaining({ code: "RUNTIME_UPGRADE_FAILED" }),
            }),
        );
    });
});

test("Given a daemon upgrade stops responding, When its budget expires, Then setup completes on the running daemon and reports the timeout", {
    timeout: 60_000,
}, async () => {
    await withUpgradeMachine("unresponsive", async (runtime, paths) => {
        const budget = upgradeBudget();
        const setup = setupMachine(runtime, paths, budget.deadline);
        await runtime.upgradeRequested;
        budget.elapse();
        const { code, events } = await setup;
        expect(code, JSON.stringify(events)).toBe(0);
        expect(events.at(-1)).toMatchObject({ status: "ready", workspace: paths.workspace });
        expect(runtime.daemonRelease()).toBe("previous");
        expect(events).toContainEqual(
            expect.objectContaining({
                status: "runtime_upgrade_skipped",
                error: expect.objectContaining({ code: "RUNTIME_UPGRADE_TIMEOUT" }),
            }),
        );
    });
});

test("Given a daemon upgrade is still switching releases when its budget expires, When the manager finishes the switch, Then setup waits for the Runtime and completes on the newest release", {
    timeout: 60_000,
}, async () => {
    await withUpgradeMachine("interrupted-switch", async (runtime, paths) => {
        const budget = upgradeBudget();
        const setup = setupMachine(runtime, paths, budget.deadline);
        await runtime.upgradeRequested;
        budget.elapse();
        const { code, events } = await setup;
        expect(code, JSON.stringify(events)).toBe(0);
        expect(events).toContainEqual(
            expect.objectContaining({
                status: "runtime_upgrade_skipped",
                error: expect.objectContaining({ code: "RUNTIME_UPGRADE_TIMEOUT" }),
            }),
        );
        const skipped = events.findIndex((event) => event["status"] === "runtime_upgrade_skipped");
        const online = events.findIndex((event, index) => index > skipped && event["status"] === "runtime_online");
        const bound = events.findIndex((event) => event["status"] === "binding_activated");
        expect(online, JSON.stringify(events)).toBeGreaterThan(skipped);
        expect(bound, JSON.stringify(events)).toBeGreaterThan(online);
        expect(events.at(-1)).toMatchObject({ status: "ready", workspace: paths.workspace });
        expect(runtime.daemonRelease()).toBe("current");
    });
});

test("Given two shared links and redeemed access, When the local owner revokes all access, Then previous links and credentials fail while local setup and another machine remain usable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-revoke-access-"));
    const documents = join(directory, "Documents");
    const configurationDirectory = join(directory, "state");
    await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
    const fixture = await createIdentityFixture({ listenOnLoopback: true });
    const signal = AbortSignal.timeout(30000);
    try {
        const owner = await fixture.createAnonymousUser();
        const other = await fixture.createAnonymousUser();
        const configuration = JSON.stringify({
            base_url: fixture.origin,
            user_token: owner.token,
            project_id: owner.projectId,
        });
        await writeFile(join(configurationDirectory, "config.json"), configuration, { mode: 0o600 });
        const request = (projectId: string, path: string, token: string, method = "GET") =>
            fetch(`${fixture.origin}/morty/api/projects/${projectId}${path}`, {
                method,
                headers: { authorization: `Bearer ${token}` },
                signal,
            });
        const share = async (projectId: string, token: string) => {
            const response = await request(projectId, "/identity/transfers", token, "POST");
            expect(response.status).toBe(201);
            return v.parse(v.object({ url: v.string() }), await response.json()).url;
        };
        const redeem = (url: string) =>
            worker.fetch(
                new Request(`${fixture.origin}/morty/api/identity/transfers/redeem`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ code: new URL(url).hash.slice("#code=".length) }),
                    signal,
                }),
                fixture.environment(fixture.origin),
            );
        const links = [await share(owner.projectId, owner.token), await share(owner.projectId, owner.token)];
        const tokens: string[] = [];
        for (const link of links) {
            for (let index = 0; index < 2; index++) {
                const response = await redeem(link);
                expect(response.status).toBe(200);
                tokens.push(v.parse(v.object({ token: v.string() }), await response.json()).token);
            }
        }
        const remote = v.parse(v.string(), tokens[0]);
        const recovery = await request(owner.projectId, "/identity/recovery-token", remote, "POST");
        expect(recovery.status).toBe(201);
        const recoveryToken = v.parse(v.object({ token: v.string() }), await recovery.json()).token;
        for (const token of [remote, recoveryToken]) {
            expect((await request(owner.projectId, "/identity/revoke-all-access", token, "POST")).status).toBe(403);
        }
        const otherLink = await share(other.projectId, other.token);
        const mismatchEvents: Readonly<Record<string, unknown>>[] = [];
        expect(
            await runSetup(["revoke-all-access", "--base-url", "http://127.0.0.1:1"], {
                state: configurationDirectory,
                documents,
                signal,
                emit: (event) => mismatchEvents.push(event),
            }),
        ).toBe(1);
        expect(mismatchEvents.at(-1)).toMatchObject({ error: { code: "LOCAL_IDENTITY_REQUIRED" } });
        const events: Readonly<Record<string, unknown>>[] = [];
        expect(
            await runSetup(["revoke-all-access"], {
                state: configurationDirectory,
                documents,
                signal,
                emit: (event) => events.push(event),
            }),
        ).toBe(0);
        expect(events.at(-1)).toMatchObject({ status: "access_revoked", projectId: owner.projectId });
        expect(JSON.stringify(events)).not.toContain(owner.token);
        for (const link of links) {
            expect((await redeem(link)).status).toBe(410);
        }
        for (const token of [...tokens, recoveryToken]) {
            expect((await request(owner.projectId, "/session", token)).status).toBe(401);
            expect((await request(owner.projectId, "/identity/transfers", token, "POST")).status).toBe(401);
        }
        expect(await readFile(join(configurationDirectory, "config.json"), "utf8")).toBe(configuration);
        expect((await request(owner.projectId, "/session", owner.token)).status).toBe(200);
        expect((await redeem(otherLink)).status).toBe(200);
        expect(
            await runSetup(["revoke-all-access", "--base-url", fixture.origin], {
                state: configurationDirectory,
                documents,
                signal,
                emit: () => undefined,
            }),
        ).toBe(0);
        expect((await redeem(await share(owner.projectId, owner.token))).status).toBe(200);
    } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
}, 30000);

test("Given setup replaced the Project but stopped before ending the previous identity, When the user revokes all access, Then nothing opens the previous Project and the current identity stays usable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-replaced-identity-"));
    const documents = join(directory, "Documents");
    const configurationDirectory = join(directory, "state");
    await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
    const fixture = await createIdentityFixture({ listenOnLoopback: true });
    const signal = AbortSignal.timeout(30000);
    try {
        const previous = await fixture.createAnonymousUser();
        const request = (projectId: string, path: string, token: string, method = "GET") =>
            fetch(`${fixture.origin}/morty/api/projects/${projectId}${path}`, {
                method,
                headers: { authorization: `Bearer ${token}` },
                signal,
            });
        const replaced = await request(previous.projectId, "/management/project/replacement", previous.token, "POST");
        expect(replaced.status).toBe(201);
        const current = v.parse(v.object({ projectId: v.string(), token: v.string() }), await replaced.json());
        // What setup saved before it stopped: the successor's identity, with the previous one still to end.
        await writeFile(
            join(configurationDirectory, "config.json"),
            JSON.stringify({
                base_url: fixture.origin,
                user_token: current.token,
                project_id: current.projectId,
                replaced_project_id: previous.projectId,
                replaced_user_token: previous.token,
            }),
            { mode: 0o600 },
        );
        expect((await request(previous.projectId, "/session", previous.token)).status).toBe(200);

        const events: Readonly<Record<string, unknown>>[] = [];
        const code = await runSetup(["revoke-all-access"], {
            state: configurationDirectory,
            documents,
            signal,
            emit: (event) => events.push(event),
        });
        expect(code, JSON.stringify(events)).toBe(0);

        expect(events.at(-1)).toMatchObject({ status: "access_revoked", projectId: current.projectId });
        expect(JSON.stringify(events)).not.toContain(previous.token);
        expect((await request(previous.projectId, "/session", previous.token)).status).toBe(401);
        expect((await request(previous.projectId, "/identity/transfers", previous.token, "POST")).status).toBe(401);
        expect((await request(current.projectId, "/session", current.token)).status).toBe(200);
        const saved = JSON.parse(await readFile(join(configurationDirectory, "config.json"), "utf8"));
        expect(saved).toEqual({ base_url: fixture.origin, user_token: current.token, project_id: current.projectId });
    } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
}, 30000);

test("Given two computers share a synced Documents folder holding the first one's earlier setup, When each sets up Morty, Then each keeps its own Machine and neither ends the other's access", {
    timeout: 120_000,
}, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "morty-setup-synced-")));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const documents = join(root, "Documents");
    const fixture = await createIdentityFixture({ listenOnLoopback: true });
    const computer = (name: string) =>
        new ControlledSetupRuntime(
            { agentId: "settings-test", agentName: "Settings Agent", reply: mortyReply, runtime: "current" },
            name,
        );
    const first = computer("Computer A");
    const second = computer("Computer B");
    const opens = async (link: unknown) => {
        const redeemed = await worker.fetch(
            new Request(`${fixture.origin}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code: new URL(String(link)).hash.slice("#code=".length) }),
            }),
            fixture.environment(fixture.origin),
        );
        expect(redeemed.status).toBe(200);
        const browser = v.parse(v.object({ projectId: v.string(), token: v.string() }), await redeemed.json());
        return async () =>
            (
                await fetch(`${fixture.origin}/morty/api/projects/${browser.projectId}/session`, {
                    headers: { authorization: `Bearer ${browser.token}` },
                })
            ).status;
    };
    try {
        // An earlier release kept computer A's identity in Documents, which syncs to computer B.
        const earlier = join(documents, "morty");
        const setUpEarlier = await setupMachine(first, {
            origin: fixture.origin,
            documents,
            state: earlier,
            workspace,
        });
        expect(setUpEarlier.code, JSON.stringify(setUpEarlier.events)).toBe(0);
        const firstBrowser = await opens(setUpEarlier.events.at(-1)?.["url"]);
        const earlierConfiguration = await readFile(join(earlier, "config.json"), "utf8");

        const onSecond = await setupMachine(second, {
            origin: fixture.origin,
            documents,
            state: join(root, "computer-b"),
            workspace,
        });

        expect(onSecond.code, JSON.stringify(onSecond.events)).toBe(0);
        expect(onSecond.events).not.toContainEqual(expect.objectContaining({ status: "project_replaced" }));
        expect(await firstBrowser()).toBe(200);
        expect(await readFile(join(earlier, "config.json"), "utf8")).toBe(earlierConfiguration);
        const secondBrowser = await opens(onSecond.events.at(-1)?.["url"]);

        const onFirst = await setupMachine(first, {
            origin: fixture.origin,
            documents,
            state: join(root, "computer-a"),
            workspace,
        });

        expect(onFirst.code, JSON.stringify(onFirst.events)).toBe(0);
        expect(onFirst.events).not.toContainEqual(expect.objectContaining({ status: "project_replaced" }));
        expect(onFirst.events).toContainEqual(expect.objectContaining({ status: "runtime_already_online" }));
        expect(JSON.parse(await readFile(join(root, "computer-a", "config.json"), "utf8"))).toMatchObject({
            project_id: JSON.parse(earlierConfiguration)["project_id"],
        });
        await expect(stat(join(earlier, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await firstBrowser()).toBe(200);
        expect(await secondBrowser()).toBe(200);
    } finally {
        await first.disconnect();
        await second.disconnect();
        await fixture.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("Given an earlier release kept this computer's identity in Documents, When the user revokes all access, Then the identity moves to this computer's state and the revocation uses it", {
    timeout: 90_000,
}, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "morty-revoke-earlier-")));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const documents = join(root, "Documents");
    const state = join(root, "state");
    const fixture = await createIdentityFixture({ listenOnLoopback: true });
    const runtime = new ControlledSetupRuntime(
        { agentId: "settings-test", agentName: "Settings Agent", reply: mortyReply, runtime: "current" },
        "Setup test Runtime",
    );
    try {
        const earlier = join(documents, "morty");
        const setUp = await setupMachine(runtime, { origin: fixture.origin, documents, state: earlier, workspace });
        expect(setUp.code, JSON.stringify(setUp.events)).toBe(0);
        const saved = v.parse(
            v.object({ project_id: v.string() }),
            JSON.parse(await readFile(join(earlier, "config.json"), "utf8")),
        );

        const events: Readonly<Record<string, unknown>>[] = [];
        const code = await runSetup(["revoke-all-access"], {
            state,
            documents,
            runtime,
            signal: AbortSignal.timeout(30_000),
            emit: (event) => events.push(event),
        });

        expect(code, JSON.stringify(events)).toBe(0);
        expect(events.at(-1)).toMatchObject({ status: "access_revoked", projectId: saved.project_id });
        expect(JSON.parse(await readFile(join(state, "config.json"), "utf8"))).toMatchObject({
            project_id: saved.project_id,
        });
        await expect(stat(join(earlier, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await runtime.disconnect();
        await fixture.close();
        await rm(root, { recursive: true, force: true });
    }
});
