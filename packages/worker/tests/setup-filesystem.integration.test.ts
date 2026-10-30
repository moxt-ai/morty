import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as v from "valibot";
import { beforeAll, expect, test } from "vitest";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { ControlledSetupRuntime } from "../../e2e/infra/setup-daemon.ts";
import worker from "../src/application.ts";
import { prepareIdentityFixture } from "./support/identity-fixture.ts";

// Exercise the package-runner boundary, including the production argument prefix.
async function writeNpxFixture(bin: string, body: string): Promise<void> {
    const script = `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2, 5)) !== JSON.stringify(['--yes', '--prefer-online', '@moxt-ai/mobius@latest'])) process.exit(64);\nprocess.argv.splice(2, 3);\n${body}`;
    if (process.platform === "win32") {
        const directory = join(bin, "node_modules", "npm", "bin");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "npx-cli.js"), script);
        await writeFile(
            join(bin, "npx.cmd"),
            '@ECHO off\r\nSET "NODE_EXE=node.exe"\r\nSET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"\r\n"%NODE_EXE%" "%NPX_CLI_JS%" %*\r\n',
        );
    } else {
        await writeFile(join(bin, "npx"), script, { mode: 0o700 });
    }
}

let createIdentityFixture: Awaited<ReturnType<typeof prepareIdentityFixture>>;
beforeAll(async () => {
    createIdentityFixture = await prepareIdentityFixture({ listenOnLoopback: true });
});

interface SetupModule {
    readonly runSetup: (
        args: readonly string[],
        host: {
            readonly state: string;
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

test.each(["fresh", "unknown", "revoked"] as const)(
    "Given an invalid Mobius state root and %s replacement state, When setup stops at preflight, Then it preserves the identity and accurately reports earlier shared access",
    {
        timeout: 30_000,
    },
    async (replacementState) => {
        const directory = await mkdtemp(join(tmpdir(), "morty-setup-state-root-"));
        const state = join(directory, "state");
        const bin = join(directory, "bin");
        await mkdir(bin);
        const fixture = await createIdentityFixture();
        try {
            if (replacementState !== "fresh") {
                const previous = await fixture.createAnonymousUser();
                const current =
                    replacementState === "unknown"
                        ? previous
                        : v.parse(
                              v.object({ projectId: v.string(), token: v.string() }),
                              await (
                                  await worker.fetch(
                                      new Request(
                                          `${fixture.origin}/morty/api/projects/${previous.projectId}/management/project/replacement`,
                                          { method: "POST", headers: { authorization: `Bearer ${previous.token}` } },
                                      ),
                                      fixture.environment(fixture.origin),
                                  )
                              ).json(),
                          );
                await mkdir(state, { mode: 0o700 });
                await writeFile(
                    join(state, "config.json"),
                    JSON.stringify({
                        base_url: fixture.origin,
                        project_id: current.projectId,
                        user_token: current.token,
                        replacement_access:
                            replacementState === "unknown"
                                ? { kind: "unknown", previousProjectId: previous.projectId }
                                : {
                                      kind: "revoked",
                                      previousProjectId: previous.projectId,
                                      projectId: current.projectId,
                                  },
                    }),
                    { mode: 0o600 },
                );
            }
            const saved = replacementState === "fresh" ? null : await readFile(join(state, "config.json"), "utf8");
            // Mobius 0.0.315 and later refuse another root's installation data with EX_CONFIG.
            const refusal =
                "MOBIUS_STATE_DIRECTORY is Mobius installation data, not a state root. Use the state root that owns it: MOBIUS_STATE_DIRECTORY=/owning-root";
            await writeNpxFixture(bin, `process.stderr.write(${JSON.stringify(`${refusal}\n`)}); process.exit(78);`);
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
                    "state-root-test",
                ],
                {
                    env: {
                        ...process.env,
                        PATH: bin,
                        MOBIUS_STATE_DIRECTORY: join(directory, "inherited-installation-data"),
                        MORTY_STATE_DIRECTORY: state,
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
            expect(output).toContain('"code":"MOBIUS_STATE_ROOT_INVALID"');
            expect(output).toContain(
                "Rerun setup with MOBIUS_STATE_DIRECTORY set to the state root that the Runtime log names",
            );
            expect(output).not.toContain("RUNTIME_PREFLIGHT_FAILED");
            expect(output).not.toContain('"status":"identity_ready"');
            if (saved === null) {
                await expect(readFile(join(state, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
                expect(output).toContain("existing Morty links keep working");
            } else {
                expect(await readFile(join(state, "config.json"), "utf8")).toBe(saved);
                expect(output).toContain(`"kind":"${replacementState}"`);
                expect(output).not.toContain("existing Morty links keep working");
                expect(output).toContain('"setupReady":false');
            }
        } finally {
            await fixture.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
);

test.each(["missing", "unlaunchable", "npm-missing", "npm-unlaunchable"] as const)(
    "Given a %s local dependency, When setup checks the Mobius executable, Then it fails before creating an identity and reports recovery instructions",
    async (failure) => {
        const directory = await mkdtemp(join(tmpdir(), "morty-setup-preflight-"));
        const state = join(directory, "state");
        const bin = join(directory, "bin");
        await mkdir(bin);
        const fixture = await createIdentityFixture();
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
                await writeNpxFixture(bin, `await import(${JSON.stringify(pathToFileURL(entry).href)});`);
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
    const state = join(directory, "state ' & workspace");
    const workspace = join(directory, "workspace with spaces & quotes '");
    await mkdir(workspace);
    const fixture = await createIdentityFixture();
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeNpxFixture(
        bin,
        `await import(${JSON.stringify(new URL("../../../third-party/mobius/packages/cli/src/cli/entrypoint.ts", import.meta.url).href)});`,
    );
    const runner = join(directory, "setup.mjs");
    await writeFile(
        runner,
        `
import { runSetup } from ${JSON.stringify(new URL("../../setup/src/setup.ts", import.meta.url).href)};
const cancellation = new AbortController();
process.exitCode = await runSetup(process.argv.slice(2), {
    state: process.env.MORTY_STATE_DIRECTORY,
    agentEnvironment: {},
    signal: cancellation.signal,
    emit(event) {
        console.log(JSON.stringify(event));
        if (event.status === 'identity_ready') cancellation.abort(new Error('User cancelled setup'));
    },
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
            workspace,
            "--harness",
            "codex",
            "--session-id",
            "native-setup",
        ],
        {
            env: {
                ...process.env,
                MORTY_STATE_DIRECTORY: state,
                MOBIUS_STATE_DIRECTORY: join(directory, "mobius-state"),
                PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env["PATH"] ?? ""}`,
            },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            signal: AbortSignal.timeout(30000),
        },
    );
    const exited = once(child, "exit");
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });
    child.stderr.resume();
    try {
        const [code] = await exited;
        const events = output
            .trim()
            .split("\n")
            .map((line) => v.parse(v.record(v.string(), v.unknown()), JSON.parse(line)));
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
        child.kill();
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
}, 30000);

test("Given a junction replaces the private Morty directory, When setup validates its local state, Then it refuses to write credentials through the link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-setup-link-"));
    const state = join(directory, "state");
    const target = join(directory, "target");
    await mkdir(target);
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
    "Given HOME and no overrides, When a user runs the setup CLI, Then identity is saved in the platform's local state directory and cancellation releases setup",
    { timeout: 30000 },
    async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-setup-home-"));
        const state =
            process.platform === "darwin"
                ? join(directory, "Library", "Application Support", "Morty")
                : join(directory, ".local", "state", "morty");
        const workspace = join(directory, "workspace");
        await mkdir(workspace);
        const bin = join(directory, "bin");
        await mkdir(bin);
        await writeNpxFixture(
            bin,
            `await import(${JSON.stringify(new URL("../../../third-party/mobius/packages/cli/src/cli/entrypoint.ts", import.meta.url).href)});`,
        );
        const fixture = await createIdentityFixture();
        const environment = Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !["MORTY_STATE_DIRECTORY", "XDG_STATE_HOME"].includes(name)),
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
                env: {
                    ...environment,
                    HOME: directory,
                    MOBIUS_STATE_DIRECTORY: join(directory, "mobius-state"),
                    PATH: `${bin}:${environment["PATH"] ?? ""}`,
                },
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
        "cancel-download",
        "When setup is cancelled while the starter downloads, Then setup stops the processes it started",
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
            const fixture = await createIdentityFixture();
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
                        workspace: directory,
                    }),
                    { mode: 0o600 },
                );
                await writeFile(join(directory, "connections.json"), JSON.stringify([connection]));
                await writeFile(join(directory, "attempts.txt"), "0");
                await writeNpxFixture(
                    bin,
                    `
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const output = process.argv.find(arg => arg.startsWith('--output-json='));
if (process.argv[2] === '--version') { process.exit(0); }
if (process.argv[2] === 'start' && ${JSON.stringify(failure === "cancel-download")}) {
    ${
        failure === "cancel-download"
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
    ${failure === "signal" ? "process.kill(process.pid, 'SIGTERM');" : failure === "recover" ? "process.exit(attempts === 1 ? 42 : 0);" : failure === "cancel-download" ? "process.exit(0);" : "process.exit(42);"}
}
`,
                );
                const runner = join(directory, "run.mjs");
                await writeFile(
                    runner,
                    `import { runSetup } from ${JSON.stringify(new URL("../../setup/src/setup.ts", import.meta.url).href)};
const cancellation = new AbortController();
process.on('SIGUSR2', () => cancellation.abort());
let time = Date.parse('2026-09-15T12:00:00Z');
process.exitCode = await runSetup(process.argv.slice(2), {
    state: process.env.MORTY_STATE_DIRECTORY, signal: cancellation.signal,
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
                    // The started daemon comes online, so setup proceeds to the handoff.
                    if (
                        (failure === "recover" || failure === "cancel-download") &&
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
                if (failure === "cancel-download" || failure === "stuck-start") {
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
        const fixture = await createIdentityFixture();
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
            const state = join(root, "state");
            const workspace = join(
                root,
                ...Array.from({ length: segments }, () => "\u00e9".repeat(segments === 8 ? 110 : 90)),
            );
            await mkdir(workspace, { recursive: true });
            const fixture = await createIdentityFixture();
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
        readonly state: string;
        readonly workspace: string;
    },
    deadline?: (milliseconds: number) => AbortSignal,
    run: {
        readonly harness?: string;
        /** The Project whose replacement the user explicitly approved. */
        readonly replaceProject?: string;
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
            ...(run.replaceProject === undefined ? [] : ["--replace-project", run.replaceProject]),
            ...(run.sessionArgument === null ? [] : ["--session-id", run.sessionArgument ?? "native-upgrade-project"]),
        ],
        {
            state: paths.state,
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

async function withUpgradeMachine(
    upgrade: ConstructorParameters<typeof ControlledSetupRuntime>[2],
    scenario: (
        runtime: ControlledSetupRuntime,
        paths: {
            readonly origin: string;
            readonly state: string;
            readonly workspace: string;
            readonly dispatch: (request: Request) => Promise<Response>;
        },
    ) => Promise<void>,
    /** The release the machine's daemon runs before setup. */
    release: ConstructorParameters<typeof ControlledSetupRuntime>[3] = "latest",
): Promise<void> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "morty-setup-upgrade-")));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const fixture = await createIdentityFixture();
    const runtime = new ControlledSetupRuntime(
        { agentId: "settings-test", agentName: "Settings Agent", reply: mortyReply },
        "Setup test Runtime",
        upgrade,
        release,
    );
    try {
        await scenario(runtime, {
            origin: fixture.origin,
            state: join(root, "state"),
            workspace,
            dispatch: async (request) => await worker.fetch(request, fixture.environment(fixture.origin)),
        });
    } finally {
        await runtime.disconnect();
        await fixture.close();
        await rm(root, { recursive: true, force: true });
    }
}

test("Given a paired machine whose online daemon runs an outdated release, When the user reruns setup, Then setup reuses the running Runtime without restarting it", {
    timeout: 90_000,
}, async () => {
    await withUpgradeMachine(
        "unavailable",
        async (runtime, paths) => {
            const first = await setupMachine(runtime, paths);
            expect(first.code, JSON.stringify(first.events)).toBe(0);
            expect(runtime.daemonRelease()).toBe("outdated");

            runtime.setUpgrade("available");
            const rerun = await setupMachine(runtime, paths);
            expect(rerun.code, JSON.stringify(rerun.events)).toBe(0);
            expect(rerun.events).toContainEqual(expect.objectContaining({ status: "runtime_already_online" }));
            expect(rerun.events.at(-1)).toMatchObject({ status: "ready", workspace: paths.workspace });
            expect(runtime.daemonRelease()).toBe("outdated");
        },
        "outdated",
    );
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

test("Given a shared Machine whose local pairing was removed, When setup has no matching replacement approval, Then shared access stays valid until the user approves that Project", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine("unavailable", async (runtime, paths) => {
        const first = await setupMachine(runtime, paths);
        expect(first.code, JSON.stringify(first.events)).toBe(0);
        const config = v.parse(
            v.object({ project_id: v.string(), user_token: v.string() }),
            JSON.parse(await readFile(join(paths.state, "config.json"), "utf8")),
        );
        const url = v.parse(v.string(), first.events.at(-1)?.["url"]);
        const redeem = async () =>
            await paths.dispatch(
                new Request(`${paths.origin}/morty/api/identity/transfers/redeem`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ code: new URLSearchParams(new URL(url).hash.slice(1)).get("code") }),
                    signal: AbortSignal.timeout(10000),
                }),
            );
        const redeemed = await redeem();
        expect(redeemed.status).toBe(200);
        const browser = v.parse(v.object({ token: v.string() }), await redeemed.json());
        const session = async () =>
            await fetch(`${paths.origin}/morty/api/projects/${config.project_id}/session`, {
                headers: { authorization: `Bearer ${browser.token}` },
                signal: AbortSignal.timeout(10000),
            });
        await runtime.forgetConnections();

        for (const replaceProject of [undefined, "another-project"]) {
            const blocked = await setupMachine(runtime, paths, undefined, {
                ...(replaceProject === undefined ? {} : { replaceProject }),
            });
            expect(blocked.code).toBe(1);
            expect(blocked.events.at(-1)).toMatchObject({
                error: {
                    code: "PROJECT_REPLACEMENT_REQUIRED",
                    replacement: { projectId: config.project_id, reason: "managed_runtime_missing" },
                },
            });
            expect((await session()).status).toBe(200);
            expect((await redeem()).status).toBe(200);
            expect(JSON.parse(await readFile(join(paths.state, "config.json"), "utf8"))).toMatchObject(config);
        }

        const approved = await setupMachine(runtime, paths, undefined, { replaceProject: config.project_id });
        expect(approved.code, JSON.stringify(approved.events)).toBe(0);
        expect(approved.events).toContainEqual(
            expect.objectContaining({ status: "replacement_access_revoked", previousProjectId: config.project_id }),
        );
        expect(approved.events.at(-1)).toMatchObject({ status: "ready", project: "replaced" });
        const retired = await fetch(`${paths.origin}/morty/api/projects/${config.project_id}/session`, {
            headers: { authorization: `Bearer ${config.user_token}` },
            signal: AbortSignal.timeout(10000),
        });
        expect(retired.status).toBe(401);
        expect((await session()).status).toBe(401);
        expect((await redeem()).status).toBe(410);
        const current = v.parse(
            v.object({ project_id: v.string() }),
            JSON.parse(await readFile(join(paths.state, "config.json"), "utf8")),
        );
        expect(current.project_id).not.toBe(config.project_id);
        const diagnostics = approved.events.filter((event) => event["status"] !== "ready");
        expect(JSON.stringify(diagnostics)).not.toContain(config.user_token);
        expect(JSON.stringify(diagnostics)).not.toContain(browser.token);
        expect(JSON.stringify(diagnostics)).not.toContain(url);

        await runtime.forgetConnections();
        const stale = await setupMachine(runtime, paths, undefined, { replaceProject: config.project_id });
        expect(stale.code).toBe(1);
        expect(stale.events.at(-1)).toMatchObject({
            error: { code: "PROJECT_REPLACEMENT_REQUIRED", replacement: { projectId: current.project_id } },
        });
    });
});

test("Given an approved replacement request times out, When setup is retried without approval, Then it reports the uncertain access state and does not silently replace the Project", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine("unavailable", async (runtime, paths) => {
        const first = await setupMachine(runtime, paths);
        expect(first.code).toBe(0);
        const config = v.parse(
            v.object({ project_id: v.string() }),
            JSON.parse(await readFile(join(paths.state, "config.json"), "utf8")),
        );
        await runtime.forgetConnections();
        const uncertain = await setupMachine(runtime, paths, undefined, {
            replaceProject: config.project_id,
            stallFromStage: "replacement",
        });
        expect(uncertain.code).toBe(1);
        expect(uncertain.events.at(-1)).toMatchObject({
            error: { replacementAccess: { kind: "unknown", previousProjectId: config.project_id } },
        });
        const retry = await setupMachine(runtime, paths);
        expect(retry.events.at(-1)).toMatchObject({
            error: {
                code: "PROJECT_REPLACEMENT_REQUIRED",
                replacementAccess: { kind: "unknown", previousProjectId: config.project_id },
            },
        });
        const finished = await setupMachine(runtime, paths, undefined, { replaceProject: config.project_id });
        expect(finished.code, JSON.stringify(finished.events)).toBe(0);
    });
});

test("Given a saved uncertain replacement and a restored local pairing, When setup runs without approval, Then it does not hide the uncertain access state behind a successful reconnection", {
    timeout: 120_000,
}, async () => {
    await withUpgradeMachine("unavailable", async (runtime, paths) => {
        expect((await setupMachine(runtime, paths)).code).toBe(0);
        const configPath = join(paths.state, "config.json");
        const config = v.parse(v.record(v.string(), v.unknown()), JSON.parse(await readFile(configPath, "utf8")));
        const projectId = v.parse(v.string(), config["project_id"]);
        // A previous run recorded its intent, but was interrupted before it could record the response.
        await writeFile(
            configPath,
            JSON.stringify({
                ...config,
                replacement_access: { kind: "unknown", previousProjectId: projectId },
            }),
            { mode: 0o600 },
        );
        const blocked = await setupMachine(runtime, paths);
        expect(blocked.code).toBe(1);
        expect(blocked.events.at(-1)).toMatchObject({
            error: {
                code: "PROJECT_REPLACEMENT_REQUIRED",
                replacement: { projectId, reason: "replacement_result_unknown" },
                replacementAccess: { kind: "unknown" },
            },
        });
        expect(blocked.events).not.toContainEqual(expect.objectContaining({ status: "ready" }));
        expect((await setupMachine(runtime, paths, undefined, { replaceProject: projectId })).code).toBe(0);
    });
});

test.each(["replacement_access_revoked", "project_replaced"])(
    "Given an approved replacement was stopped at %s, When the user retries with the same approval, Then both the failure and the finished setup report that earlier access was revoked",
    {
        timeout: 120_000,
    },
    async (interruptAt) => {
        await withUpgradeMachine("unavailable", async (runtime, paths) => {
            const first = await setupMachine(runtime, paths);
            expect(first.events.at(-1)).toMatchObject({ status: "ready", project: "created" });
            const config = v.parse(
                v.object({ project_id: v.string(), user_token: v.string() }),
                JSON.parse(await readFile(join(paths.state, "config.json"), "utf8")),
            );
            await runtime.forgetConnections();

            const stopped = await setupMachine(runtime, paths, undefined, {
                replaceProject: config.project_id,
                interruptAt,
            });
            expect(stopped.code, JSON.stringify(stopped.events)).not.toBe(0);
            expect(stopped.events).not.toContainEqual(expect.objectContaining({ status: "ready" }));
            expect(stopped.events.at(-1)).toMatchObject({
                error: {
                    replacementAccess: { kind: "revoked", previousProjectId: config.project_id, setupReady: false },
                },
            });

            const saved = JSON.parse(await readFile(join(paths.state, "config.json"), "utf8"));
            if (interruptAt === "replacement_access_revoked") {
                expect(saved).toMatchObject({
                    project_id: config.project_id,
                    replacement_access: { kind: "unknown", previousProjectId: config.project_id },
                });
            } else {
                expect(saved).toMatchObject({
                    replaced_project_id: config.project_id,
                    replaced_user_token: config.user_token,
                    replacement_access: {
                        kind: "revoked",
                        previousProjectId: config.project_id,
                        projectId: saved.project_id,
                    },
                });
            }

            const finished = await setupMachine(runtime, paths, undefined, { replaceProject: config.project_id });
            expect(finished.code, JSON.stringify(finished.events)).toBe(0);
            expect(finished.events.at(-1)).toMatchObject({ status: "ready", project: "replaced" });

            const again = await setupMachine(runtime, paths);
            expect(again.events.at(-1)).toMatchObject({ status: "ready", project: "reused" });
            const completed = JSON.parse(await readFile(join(paths.state, "config.json"), "utf8"));
            for (const key of ["replacement_access", "replaced_project_id", "replaced_user_token"]) {
                expect(completed).not.toHaveProperty(key);
            }
        });
    },
);

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
        await rm(configPath);
        await writeFile(configPath, JSON.stringify(saved), { mode: 0o600 });

        const rerun = await setupMachine(runtime, paths);
        expect(rerun.code, JSON.stringify(rerun.events)).toBe(0);
        expect(rerun.events).toContainEqual(expect.objectContaining({ status: "runtime_reused" }));
        expect(rerun.events.at(-1)).toMatchObject({ status: "ready", workspace: paths.workspace });
        expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ agent_ref: "settings-test" });
    });
});

test("Given two shared links and redeemed access, When the local owner revokes all access, Then previous links and credentials fail while local setup and another machine remain usable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-revoke-access-"));
    const configurationDirectory = join(directory, "state");
    await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
    const fixture = await createIdentityFixture();
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
                signal,
                emit: (event) => mismatchEvents.push(event),
            }),
        ).toBe(1);
        expect(mismatchEvents.at(-1)).toMatchObject({ error: { code: "LOCAL_IDENTITY_REQUIRED" } });
        const events: Readonly<Record<string, unknown>>[] = [];
        expect(
            await runSetup(["revoke-all-access"], {
                state: configurationDirectory,
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
    const configurationDirectory = join(directory, "state");
    await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
    const fixture = await createIdentityFixture();
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
                replacement_access: {
                    kind: "revoked",
                    previousProjectId: previous.projectId,
                    projectId: current.projectId,
                },
            }),
            { mode: 0o600 },
        );
        expect((await request(previous.projectId, "/session", previous.token)).status).toBe(200);

        const events: Readonly<Record<string, unknown>>[] = [];
        const code = await runSetup(["revoke-all-access"], {
            state: configurationDirectory,
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
        expect(saved).toEqual({
            base_url: fixture.origin,
            user_token: current.token,
            project_id: current.projectId,
            replacement_access: {
                kind: "revoked",
                previousProjectId: previous.projectId,
                projectId: current.projectId,
            },
        });
    } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
}, 30000);
