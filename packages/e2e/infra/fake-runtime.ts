import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultFakeAgentHarness } from "../../../third-party/mobius/tests/infra/agent-harness.ts";
import { fakeAgentHarnessCatalog } from "../../../third-party/mobius/tests/infra/platform-agent-harness.ts";
import type { SetupRuntime } from "../../setup/src/setup.ts";
import { jsonRequest, text } from "./chat-api.ts";

const DAEMON_READY_TIMEOUT_MILLISECONDS = 30_000;

type Connection = Readonly<{
    app_id: string;
    channel_id: string;
    connection_id: string;
    runtime_id: string;
    credential: string;
    origin: string;
}>;

function isReadyMessage(value: unknown): value is { readonly kind: "ready" } {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 1 &&
        Reflect.get(value, "kind") === "ready"
    );
}

async function waitForDaemonReady(
    daemon: ReturnType<typeof spawn>,
    exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>,
    signal: AbortSignal,
): Promise<void> {
    const deadline = AbortSignal.timeout(DAEMON_READY_TIMEOUT_MILLISECONDS);
    const operationSignal = AbortSignal.any([signal, deadline]);
    await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
            daemon.removeListener("message", onMessage);
            operationSignal.removeEventListener("abort", onAbort);
        };
        const onMessage = (message: unknown): void => {
            if (!isReadyMessage(message)) {
                return;
            }
            cleanup();
            resolve();
        };
        const onAbort = (): void => {
            cleanup();
            reject(signal.aborted ? signal.reason : new Error("The E2E production daemon did not become ready"));
        };
        daemon.on("message", onMessage);
        operationSignal.addEventListener("abort", onAbort, { once: true });
        void exited.then(({ code, signal: exitSignal }) => {
            cleanup();
            reject(
                new Error(
                    `The E2E production daemon stopped before becoming ready (${code?.toString() ?? exitSignal ?? "unknown"})`,
                ),
            );
        });
        if (operationSignal.aborted) {
            onAbort();
        }
    });
}

async function connectControlledHarness(connection: Connection, outerSignal: AbortSignal, logPath: string) {
    const directory = await mkdtemp(join(tmpdir(), "morty-e2e-agent-harness-"));
    const workspace = join(directory, "workspace");
    const harnessState = join(directory, "harness");
    await Promise.all([mkdir(workspace), mkdir(harnessState)]);
    const configurationPath = join(directory, "daemon.json");
    await writeFile(
        configurationPath,
        JSON.stringify({
            channelId: connection.channel_id,
            credential: connection.credential,
            directory,
            endpoint: connection.origin,
            harnessState,
            workspace,
        }),
        { mode: 0o600 },
    );
    const log = await open(logPath, "a", 0o600);
    const runner = fileURLToPath(
        new URL("../../../third-party/mobius/tests/infra/run-agent-harness-daemon.ts", import.meta.url),
    );
    const executable = fileURLToPath(
        new URL("../../../third-party/mobius/packages/mini-client/node_modules/.bin/tsx", import.meta.url),
    );
    const daemon = spawn(executable, [runner, configurationPath], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: process.env,
        stdio: ["ignore", log.fd, log.fd, "ipc"],
    });
    let lifecycle: { readonly kind: "running" } | { readonly kind: "stopping" } = { kind: "running" };
    const failed = Promise.withResolvers<never>();
    const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
        daemon.once("close", (code, signal) => {
            resolve({ code, signal });
            if (lifecycle.kind === "running") {
                failed.reject(
                    new Error(
                        `The E2E production daemon stopped unexpectedly (${code?.toString() ?? signal ?? "unknown"})`,
                    ),
                );
            }
        });
        daemon.once("error", (cause) => {
            if (lifecycle.kind === "running") {
                failed.reject(new Error("The E2E production daemon could not start", { cause }));
            }
        });
    });
    const failure = failed.promise;
    void failure.catch(() => undefined);
    const abort = (): void => {
        lifecycle = { kind: "stopping" };
        if (daemon.exitCode === null && daemon.signalCode === null) {
            daemon.kill("SIGKILL");
        }
    };
    const cancelStartup = (): void => abort();
    outerSignal.addEventListener("abort", cancelStartup, { once: true });
    if (outerSignal.aborted) {
        cancelStartup();
    }
    try {
        await waitForDaemonReady(daemon, exited, outerSignal);
    } catch (cause) {
        outerSignal.removeEventListener("abort", cancelStartup);
        abort();
        await exited;
        await log.close();
        await rm(directory, { recursive: true, force: true });
        throw cause;
    }
    outerSignal.removeEventListener("abort", cancelStartup);
    return {
        failure,
        [Symbol.asyncDispose]: async () => {
            abort();
            await exited;
            await log.close();
            const diagnostic = await readFile(join(directory, "logs", "daemon.log"), "utf8").catch(() => "");
            if (diagnostic.length > 0) {
                await appendFile(logPath, diagnostic);
            }
            await rm(directory, { recursive: true, force: true });
        },
    };
}

/** Setup CLI replacement that runs the production daemon with a controlled Agent harness. */
export class FakeRuntime implements SetupRuntime {
    readonly #saved = new Map<string, Connection>();
    readonly #active = new Map<string, Awaited<ReturnType<typeof connectControlledHarness>>>();
    readonly #failed = Promise.withResolvers<never>();
    readonly failure = this.#failed.promise;

    constructor() {
        void this.failure.catch(() => undefined);
    }

    readonly run: SetupRuntime["run"] = async (directory, args, _cwd, signal) => {
        signal.throwIfAborted();
        const result = { pid: process.pid, logPath: join(directory, "controlled-harness-runtime.log") };
        if (args[0] === "pair" && args[1] === "list") {
            const output = args.find((argument) => argument.startsWith("--output-json="));
            if (output === undefined) {
                throw new Error("Missing pair list output path");
            }
            await writeFile(
                output.slice("--output-json=".length),
                JSON.stringify(
                    Array.from(this.#saved.values(), ({ app_id, connection_id, runtime_id }) => ({
                        app_id,
                        connection_id,
                        runtime_id,
                    })),
                ),
            );
            return result;
        }
        const option = (name: string): string => {
            const index = args.indexOf(name);
            if (index === -1) {
                throw new Error(`Missing ${name}`);
            }
            return text(args[index + 1], name);
        };
        if (args[0] === "start") {
            const connection = this.#saved.get(option("--connection"));
            if (connection === undefined) {
                throw new Error("Unknown controlled Runtime connection");
            }
            await this.#connect(connection, signal, result.logPath);
            return result;
        }
        if (args[0] !== "pair") {
            throw new Error(`Unsupported controlled Runtime command: ${args[0]}`);
        }
        const origin = option("--url");
        const claim = await jsonRequest(origin, `/mobius/api/v1/runtime-pairings/${option("--pairing")}/redeem`, {
            body: {
                agents: fakeAgentHarnessCatalog([defaultFakeAgentHarness]),
                installableAgents: [],
                machineName: "Browser test Runtime",
                pairingCode: option("--code"),
                workspaceName: "Test workspace",
            },
            signal,
        });
        const connection: Connection = {
            app_id: text(claim.appId, "App ID"),
            channel_id: text(claim.channelId, "Channel ID"),
            connection_id: crypto.randomUUID(),
            runtime_id: text(claim.runtimeId, "Runtime ID"),
            credential: text(claim.runtimeCredential, "Runtime credential"),
            origin,
        };
        this.#saved.set(connection.connection_id, connection);
        await this.#connect(connection, signal, result.logPath);
        return result;
    };

    async #connect(connection: Connection, signal: AbortSignal, logPath: string): Promise<void> {
        if (this.#active.has(connection.connection_id)) {
            return;
        }
        const runtime = await connectControlledHarness(connection, signal, logPath);
        this.#active.set(connection.connection_id, runtime);
        void runtime.failure.catch(this.#failed.reject);
    }

    readonly disconnect = async (): Promise<void> => {
        const active = Array.from(this.#active.values());
        this.#active.clear();
        await Promise.all(active.map(async (runtime) => runtime[Symbol.asyncDispose]()));
    };
}
