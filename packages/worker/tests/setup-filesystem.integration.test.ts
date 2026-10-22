import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as v from "valibot";
import { expect, test } from "vitest";
import { createIdentityFixture } from "./support/identity-fixture.ts";

interface SetupModule {
    readonly runSetup: (
        args: readonly string[],
        host: {
            readonly documents: string;
            readonly signal: AbortSignal;
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

async function localOrigin(): Promise<string> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing local port");
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    return `http://127.0.0.1:${address.port}`;
}

test("Given a local workspace and private Documents path, When setup creates its identity and the user cancels, Then credentials remain private and can be reused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-setup-filesystem-"));
    const documents = join(directory, "Documents ' & workspace");
    const workspace = join(directory, "workspace with spaces & quotes '");
    await Promise.all([documents, workspace].map((path) => mkdir(path)));
    const fixture = await createIdentityFixture({ appOrigin: await localOrigin() });
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
                documents,
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
        const configPath = join(documents, "morty", "config.json");
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
    const target = join(directory, "target");
    await Promise.all([documents, target].map((path) => mkdir(path)));
    await symlink(target, join(documents, "morty"), process.platform === "win32" ? "junction" : "dir");
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
                    documents,
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
    "Given HOME and a redirected XDG Documents folder with no override, When a user runs the setup CLI, Then identity is saved under HOME/Documents and cancellation releases setup",
    { timeout: 30000 },
    async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-setup-xdg-"));
        const documents = join(directory, "Documents");
        const redirectedDocuments = join(directory, "Redirected Documents & spaces");
        const configuration = join(directory, "xdg-config");
        const workspace = join(directory, "workspace");
        await Promise.all([redirectedDocuments, configuration, workspace].map((path) => mkdir(path)));
        await writeFile(join(configuration, "user-dirs.dirs"), `XDG_DOCUMENTS_DIR="${redirectedDocuments}"\n`);
        const fixture = await createIdentityFixture({ appOrigin: await localOrigin() });
        const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "DOCUMENT_DIR"));
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
                env: { ...environment, HOME: directory, XDG_CONFIG_HOME: configuration },
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
            expect((await stat(documents)).isDirectory()).toBe(true);
            const saved: unknown = JSON.parse(await readFile(join(documents, "morty/config.json"), "utf8"));
            expect(saved).toMatchObject({ base_url: fixture.origin });
            await expect(stat(join(redirectedDocuments, "morty/config.json"))).rejects.toMatchObject({
                code: "ENOENT",
            });
            expect(output).toContain('"code":"CANCELLED"');
        } finally {
            child.kill();
            await fixture.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
);

for (const failure of ["exit", "signal", "cancel", "recover"]) {
    test.runIf(process.platform !== "win32")(
        `Given an offline managed Runtime, When its starter ${failure === "cancel" ? "fails and setup is cancelled during recovery" : `fails by ${failure}`}, Then setup reports actionable diagnostics and bounds recovery`,
        async () => {
            const directory = await mkdtemp(join(tmpdir(), "morty-setup-start-"));
            const documents = join(directory, "Documents");
            const bin = join(directory, "bin");
            await Promise.all([mkdir(join(documents, "morty"), { recursive: true }), mkdir(bin)]);
            const fixture = await createIdentityFixture({ appOrigin: await localOrigin() });
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
                    join(documents, "morty/config.json"),
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
import { readFileSync, writeFileSync } from 'node:fs';
const output = process.argv.find(arg => arg.startsWith('--output-json='));
if (output) { writeFileSync(output.slice('--output-json='.length), readFileSync('connections.json')); }
else {
    const attempts = Number(readFileSync('attempts.txt', 'utf8')) + 1;
    writeFileSync('attempts.txt', String(attempts));
    ${failure === "signal" ? "process.kill(process.pid, 'SIGTERM');" : failure === "recover" ? "process.exit(attempts === 1 ? 42 : 0);" : "process.exit(42);"}
}
`,
                    { mode: 0o700 },
                );
                const runner = join(directory, "run.mjs");
                await writeFile(
                    runner,
                    `import { runSetup } from ${JSON.stringify(new URL("../../setup/src/setup.ts", import.meta.url).href)};
const cancellation = new AbortController();
let time = Date.parse('2026-09-15T12:00:00Z');
process.exitCode = await runSetup(process.argv.slice(2), {
    documents: process.env.DOCUMENT_DIR, signal: cancellation.signal,
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
                        env: { ...process.env, DOCUMENT_DIR: documents, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
                        stdio: ["ignore", "pipe", "pipe"],
                        signal: AbortSignal.timeout(30000),
                    },
                );
                const exited = once(child, "exit");
                let output = "";
                let recovery: Promise<void> | undefined;
                child.stdout.on("data", (chunk) => {
                    output += chunk.toString();
                    if (
                        failure === "recover" &&
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

test.runIf(process.env["MORTY_VERIFY_SYSTEM_DOCUMENTS"] === "true" && process.platform === "darwin")(
    "Given DOCUMENT_DIR is unset on macOS, When setup connects and the user cancels, Then the private identity is saved under ~/Documents",
    async () => {
        if (process.env["CI"] !== "true" || process.env["DOCUMENT_DIR"] !== undefined) {
            throw new Error("System Documents verification requires an isolated CI runner without DOCUMENT_DIR");
        }
        const documents = join(homedir(), "Documents");
        const configuration = join(documents, "morty");
        try {
            await stat(configuration);
            throw new Error("Refusing to overwrite existing Morty configuration");
        } catch (cause) {
            if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
                throw cause;
            }
        }
        await mkdir(documents, { recursive: true });
        const workspace = await mkdtemp(join(tmpdir(), "morty-macos-workspace-"));
        const fixture = await createIdentityFixture({ appOrigin: await localOrigin() });
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
                    documents: "",
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
