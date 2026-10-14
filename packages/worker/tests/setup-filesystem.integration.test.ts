import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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

test.runIf(process.platform === "linux")(
    "Given Linux has a configured XDG Documents folder and no DOCUMENT_DIR override, When a user runs the setup CLI, Then identity is saved in that folder and cancellation releases setup",
    { timeout: 30000 },
    async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-setup-xdg-"));
        const documents = join(directory, "Redirected Documents & spaces");
        const configuration = join(directory, "xdg-config");
        const workspace = join(directory, "workspace");
        await Promise.all([documents, configuration, workspace].map((path) => mkdir(path)));
        await writeFile(join(configuration, "user-dirs.dirs"), `XDG_DOCUMENTS_DIR="${documents}"\n`);
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
            const saved: unknown = JSON.parse(await readFile(join(documents, "morty/config.json"), "utf8"));
            expect(saved).toMatchObject({ base_url: fixture.origin });
            expect(output).toContain('"code":"CANCELLED"');
        } finally {
            child.kill();
            await fixture.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
);

test.runIf(process.env["MORTY_VERIFY_SYSTEM_DOCUMENTS"] === "true" && process.platform === "darwin")(
    "Given macOS provides its Documents folder and DOCUMENT_DIR is unset, When setup connects and the user cancels, Then the private identity is saved in the system Documents folder",
    async () => {
        if (process.env["CI"] !== "true" || process.env["DOCUMENT_DIR"] !== undefined) {
            throw new Error("System Documents verification requires an isolated CI runner without DOCUMENT_DIR");
        }
        const { stdout } = await promisify(execFile)(
            "/usr/bin/osascript",
            ["-e", "POSIX path of (path to documents folder)"],
            {
                timeout: 10000,
                signal: AbortSignal.timeout(10000),
            },
        );
        const documents = stdout.trim();
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
