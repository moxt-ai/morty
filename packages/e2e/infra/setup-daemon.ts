import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessReplyPlan } from "@moxt-ai/mobius-test-support/fake-daemon";
import {
    type ControlledAgentBehavior,
    connectControlledAgentRuntime,
    createMortyFakeDaemon,
} from "../../../tests/support/fake-daemon/runtime.ts";
import type { SetupRuntime } from "../../setup/src/setup.ts";
import { jsonRequest, text } from "./chat-api.ts";

type Connection = Readonly<{
    app_id: string;
    connection_id: string;
    runtime_id: string;
    channel_id: string;
    credential: string;
    origin: string;
}>;

/** How `mobius upgrade` behaves on the controlled machine. */
type ControlledUpgrade = "available" | "unavailable" | "unresponsive";

/** Setup CLI test port backed by the production daemon and a controlled Agent harness. */
export class ControlledSetupRuntime implements SetupRuntime {
    readonly #saved = new Map<string, Connection>();
    readonly #active = new Map<string, Awaited<ReturnType<typeof connectControlledAgentRuntime>>>();
    readonly #failed = Promise.withResolvers<never>();
    readonly failure = this.#failed.promise;

    readonly #options: ControlledAgentBehavior;
    readonly #machineName: string;
    #upgrade: ControlledUpgrade;
    #release: NonNullable<ControlledAgentBehavior["runtime"]>;
    readonly #upgradeRequested = Promise.withResolvers<void>();
    /** Settles when setup first asks for an upgrade. */
    readonly upgradeRequested = this.#upgradeRequested.promise;
    /**
     * `options.runtime` is the release the machine's daemon runs before setup.
     * `upgrade` says how `mobius upgrade` behaves.
     */
    constructor(options: ControlledAgentBehavior, machineName: string, upgrade: ControlledUpgrade = "available") {
        this.#machineName = machineName;
        this.#options = options;
        this.#upgrade = upgrade;
        this.#release = options.runtime ?? "current";
        // The fixture races failures against the browser scenario; retain early failures too.
        void this.failure.catch(() => undefined);
    }

    readonly run: SetupRuntime["run"] = async (directory, args, _cwd, signal) => {
        signal.throwIfAborted();
        const result = { pid: process.pid, logPath: join(directory, "controlled-runtime.log") };
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
        if (args[0] === "upgrade") {
            await this.#upgradeDaemon(signal);
            return result;
        }
        if (args[0] === "start") {
            const connection = this.#saved.get(option("--connection"));
            if (connection === undefined) {
                throw new Error("Unknown controlled Runtime connection");
            }
            await this.#connect(connection, signal);
            return result;
        }
        if (args[0] !== "pair") {
            throw new Error(`Unsupported controlled Runtime command: ${args[0]}`);
        }
        const origin = option("--url");
        const daemon = createMortyFakeDaemon(this.#options);
        const claim = await jsonRequest(origin, `/mobius/api/v1/runtime-pairings/${option("--pairing")}/redeem`, {
            body: {
                agents: daemon.catalog,
                machineName: this.#machineName,
                pairingCode: option("--code"),
                workspaceName: "Test project",
            },
            signal,
        });
        const connection: Connection = {
            app_id: text(claim["appId"], "App ID"),
            channel_id: text(claim["channelId"], "Channel ID"),
            connection_id: crypto.randomUUID(),
            runtime_id: text(claim["runtimeId"], "Runtime ID"),
            credential: text(claim["runtimeCredential"], "Runtime credential"),
            origin,
        };
        this.#saved.set(connection.connection_id, connection);
        await this.#connect(connection, signal);
        return result;
    };

    /** Changes how later `mobius upgrade` runs behave, such as when the registry becomes reachable. */
    readonly setUpgrade = (upgrade: ControlledUpgrade): void => {
        this.#upgrade = upgrade;
    };

    /** The daemon release `mobius --version` reports. */
    readonly daemonRelease = (): NonNullable<ControlledAgentBehavior["runtime"]> => this.#release;

    // Like `mobius upgrade`: the running daemon switches to the newest release, and
    // its active connections come back on it.
    async #upgradeDaemon(signal: AbortSignal): Promise<void> {
        this.#upgradeRequested.resolve();
        switch (this.#upgrade) {
            case "unavailable":
                throw new Error("npm could not return a valid latest Mobius version");
            case "unresponsive":
                // A download that never finishes: only cancellation ends it.
                await new Promise<never>((_resolve, reject) => {
                    signal.throwIfAborted();
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                });
                return;
            case "available":
                break;
            default:
                return this.#upgrade satisfies never;
        }
        if (this.#release === "current") {
            return;
        }
        this.#release = "current";
        const reconnecting = Array.from(this.#active.keys(), (id) => this.#saved.get(id)).filter(
            (connection) => connection !== undefined,
        );
        await this.disconnect();
        for (const connection of reconnecting) {
            await this.#connect(connection, signal);
        }
    }

    async #connect(connection: Connection, signal: AbortSignal): Promise<void> {
        if (this.#active.has(connection.connection_id)) {
            return;
        }
        const daemon = await connectControlledAgentRuntime({
            behavior: { ...this.#options, runtime: this.#release },
            connection: {
                channelId: connection.channel_id,
                origin: connection.origin,
                runtimeCredential: connection.credential,
            },
            signal,
        });
        this.#active.set(connection.connection_id, daemon);
        void daemon.failure.catch((error: unknown) => {
            if (this.#active.get(connection.connection_id) === daemon) {
                this.#failed.reject(error);
            }
        });
    }

    readonly disconnect = async (): Promise<void> => {
        const active = Array.from(this.#active.values());
        this.#active.clear();
        await Promise.all(active.map((daemon) => daemon[Symbol.asyncDispose]()));
    };

    /** Restarts the production engines while keeping their persisted session directories. */
    readonly restart = async (): Promise<void> => {
        const active = Array.from(this.#active.values());
        await Promise.all(active.map((daemon) => daemon.disconnect()));
        await Promise.all(active.map((daemon) => daemon.reconnect()));
    };

    /** Simulates the manager forgetting every saved Runtime connection. */
    readonly forgetConnections = async (): Promise<void> => {
        await this.disconnect();
        this.#saved.clear();
    };

    readonly continueReply = async (prompt: string, plan: HarnessReplyPlan): Promise<void> => {
        for (const daemon of this.#active.values()) {
            await daemon.continueReply(prompt, plan);
        }
    };

    readonly writeFiles = async (files: NonNullable<ControlledAgentBehavior["files"]>): Promise<void> => {
        for (const daemon of this.#active.values()) {
            await daemon.writeFiles(files);
        }
    };
}
