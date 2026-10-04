import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectFakeAgentDaemon, fakeAgentCatalog } from "@moxt-ai/mobius-test/fake-daemon/connection";
import type { FakeDaemonOptions } from "@moxt-ai/mobius-test/fake-daemon/model";
import type { SetupRuntime } from "../../setup/src/setup.ts";
import { jsonRequest, text } from "./chat-api.ts";

type Connection = Readonly<{
    app_id: string;
    connection_id: string;
    runtime_id: string;
    credential: string;
    origin: string;
}>;

/** Stateful replacement for the local daemon, including its Setup CLI port. */
export class FakeSetupDaemon implements SetupRuntime {
    readonly #saved = new Map<string, Connection>();
    readonly #active = new Map<string, Awaited<ReturnType<typeof connectFakeAgentDaemon>>>();
    readonly #failed = Promise.withResolvers<never>();
    readonly failure = this.#failed.promise;

    readonly #options: FakeDaemonOptions;
    constructor(options: FakeDaemonOptions) {
        this.#options = options;
        // The fixture races failures against the browser scenario; retain early failures too.
        void this.failure.catch(() => undefined);
    }

    readonly run: SetupRuntime["run"] = async (directory, args, _cwd, signal) => {
        signal.throwIfAborted();
        const result = { pid: process.pid, logPath: join(directory, "fake-runtime.log") };
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
                throw new Error("Unknown fake Runtime connection");
            }
            await this.#connect(connection, signal);
            return result;
        }
        if (args[0] !== "pair") {
            throw new Error(`Unsupported fake Runtime command: ${args[0]}`);
        }
        const origin = option("--url");
        const claim = await jsonRequest(origin, `/mobius/api/v1/runtime-pairings/${option("--pairing")}/redeem`, {
            body: {
                agents: fakeAgentCatalog(this.#options),
                installableAgents: [],
                machineName: "Browser test Runtime",
                pairingCode: option("--code"),
                workspaceName: "Test workspace",
            },
            signal,
        });
        const connection: Connection = {
            app_id: text(claim.appId, "App ID"),
            connection_id: crypto.randomUUID(),
            runtime_id: text(claim.runtimeId, "Runtime ID"),
            credential: text(claim.runtimeCredential, "Runtime credential"),
            origin,
        };
        this.#saved.set(connection.connection_id, connection);
        await this.#connect(connection, signal);
        return result;
    };

    async #connect(connection: Connection, signal: AbortSignal): Promise<void> {
        if (this.#active.has(connection.connection_id)) {
            return;
        }
        const daemon = await connectFakeAgentDaemon({
            origin: connection.origin,
            runtimeCredential: connection.credential,
            behavior: this.#options,
            signal,
        });
        this.#active.set(connection.connection_id, daemon);
        void daemon.failure.catch(this.#failed.reject);
    }

    readonly disconnect = async (): Promise<void> => {
        const active = Array.from(this.#active.values());
        this.#active.clear();
        await Promise.all(active.map((daemon) => daemon[Symbol.asyncDispose]()));
    };
}
