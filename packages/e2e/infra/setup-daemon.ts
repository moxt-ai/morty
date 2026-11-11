import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessReplyPlan } from "@morty-build/runtime-test-support/fake-daemon";
import {
    type ControlledAgentBehavior,
    connectControlledAgentRuntime,
    createMortyFakeDaemon,
} from "../../../tests/support/fake-daemon/runtime.ts";
import type { ComputerCredentials } from "../../cli/src/engine/runtime/connection/computer-credentials.ts";
import type { SetupRuntime } from "../../cli/src/setup/setup.ts";
import { memoryComputerCredentials } from "../../cli/tests/support/computer-credentials.ts";
import { jsonRequest, text } from "./chat-api.ts";

type Connection = Readonly<{
    pairingGeneration: string;
    computer_id: string;
    credential: string;
    origin: string;
}>;

/** An installed Agent the computer's Morty cannot offer, as `morty agents` reports it. */
export interface UnavailableAgentReport {
    readonly harness: string;
    readonly label: string;
    readonly status: string;
    readonly code: string;
    readonly message: string;
    readonly recoveryCommand: string;
}

/** How `morty upgrade` behaves on the controlled computer. */
type ControlledUpgrade = "available" | "unavailable" | "unresponsive" | "interrupted-switch";

/**
 * The Morty release the computer's daemon runs: an outdated one that `morty upgrade` switches to the
 * latest, or the latest already. Only the release switch is modeled; the Agent always runs on this
 * checkout's daemon engine.
 */
type DaemonRelease = "outdated" | "latest";

/** Setup CLI test port backed by the production daemon and a controlled Agent harness. */
export class ControlledSetupRuntime implements SetupRuntime {
    readonly #saved = new Map<string, Connection>();
    /** Each saved connection's relay credential, which rotates on every connection like the daemon's saved one. */
    readonly #credentials = new Map<string, ComputerCredentials>();
    readonly #active = new Map<string, Awaited<ReturnType<typeof connectControlledAgentRuntime>>>();
    readonly #failed = Promise.withResolvers<never>();
    readonly failure = this.#failed.promise;

    #options: ControlledAgentBehavior;
    /** What `morty agents --output-json` reports as unavailable; `null` is a release without that option. */
    #unavailableAgents: readonly UnavailableAgentReport[] | null = null;
    /** Agents `morty agents` reports ready although the running Computer did not publish them. */
    #unpublishedReadyAgents: readonly { readonly harness: string; readonly label: string }[] = [];
    readonly #computerName: string;
    #upgrade: ControlledUpgrade;
    #release: DaemonRelease;
    readonly #upgradeRequested = Promise.withResolvers<void>();
    /** Settles when setup first asks for an upgrade. */
    readonly upgradeRequested = this.#upgradeRequested.promise;
    /**
     * `upgrade` says how `morty upgrade` behaves; `release` is the release the computer's daemon runs before setup.
     */
    constructor(
        options: ControlledAgentBehavior,
        computerName: string,
        upgrade: ControlledUpgrade = "available",
        release: DaemonRelease = "latest",
    ) {
        this.#computerName = computerName;
        this.#options = options;
        this.#upgrade = upgrade;
        this.#release = release;
        // The fixture races failures against the browser scenario; retain early failures too.
        void this.failure.catch(() => undefined);
    }

    readonly run: SetupRuntime["run"] = async (directory, args, _cwd, signal, input) => {
        signal.throwIfAborted();
        const result = { pid: process.pid, logPath: join(directory, "controlled-runtime.log") };
        if (args[0] === "--version") {
            return result;
        }
        if (args[0] === "pair" && args[1] === "list") {
            const output = args.find((argument) => argument.startsWith("--output-json="));
            if (output === undefined) {
                throw new Error("Missing pair list output path");
            }
            await writeFile(
                output.slice("--output-json=".length),
                JSON.stringify(
                    Array.from(this.#saved.values(), ({ computer_id }) => ({
                        computer_id,
                    })),
                ),
            );
            return result;
        }
        if (args[0] === "agents") {
            const output = args.find((argument) => argument.startsWith("--output-json="));
            if (output === undefined || this.#unavailableAgents === null) {
                throw new Error("Unsupported controlled Computer command: agents");
            }
            await writeFile(
                output.slice("--output-json=".length),
                JSON.stringify({
                    available: [...createMortyFakeDaemon(this.#options).catalog, ...this.#unpublishedReadyAgents].map(
                        ({ harness, label }) => ({ harness, label, status: "ready" }),
                    ),
                    unavailable: this.#unavailableAgents,
                }),
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
            const connection = Array.from(this.#saved.values()).at(-1);
            if (connection === undefined) {
                throw new Error("Unknown controlled Computer connection");
            }
            await this.#connect(connection, signal);
            return result;
        }
        if (args[0] !== "pair") {
            throw new Error(`Unsupported controlled Computer command: ${args[0]}`);
        }
        // Like the released CLI's `--code-stdin`: the code arrives on standard input and never in the arguments.
        if (!args.includes("--code-stdin") || input === undefined || args.includes(input.trim())) {
            throw new Error("Setup must pass the pairing code on standard input");
        }
        const origin = option("--url");
        const daemon = createMortyFakeDaemon(this.#options);
        const claim = await jsonRequest(origin, `/morty/api/v1/pairings/${option("--computer")}/redeem`, {
            body: {
                agents: daemon.catalog,
                computerName: this.#computerName,
                pairingCode: input.trim(),
                workspaceName: "Test project",
            },
            signal,
        });
        const connection: Connection = {
            computer_id: text(claim["computerId"], "Channel ID"),
            pairingGeneration: crypto.randomUUID(),
            credential: text(claim["computerCredential"], "Computer credential"),
            origin,
        };
        this.#saved.set(connection.pairingGeneration, connection);
        this.#credentials.set(connection.pairingGeneration, memoryComputerCredentials(connection.credential));
        await this.#connect(connection, signal);
        return result;
    };

    /**
     * Installs other Agents on the computer. Like the manager after an install, running connections restart and
     * publish the new catalog once they reconnect; later connections offer the same Agents.
     */
    readonly installAgents = async (
        agents: Pick<ControlledAgentBehavior, "additionalAgents" | "harness" | "agentName">,
    ): Promise<void> => {
        this.#options = { ...this.#options, ...agents };
        for (const daemon of this.#active.values()) {
            await daemon.restartWithAgents(agents);
        }
    };

    /**
     * Sets what this computer's Morty reports: Agents it cannot offer, such as one the user has not signed in to, and
     * Agents that are ready now but missing from the catalog a running Computer published at startup.
     */
    readonly reportAgentInventory = (
        unavailable: readonly UnavailableAgentReport[],
        unpublishedReady: readonly { readonly harness: string; readonly label: string }[] = [],
    ): void => {
        this.#unavailableAgents = unavailable;
        this.#unpublishedReadyAgents = unpublishedReady;
    };

    /** Changes how later `morty upgrade` runs behave, such as when the registry becomes reachable. */
    readonly setUpgrade = (upgrade: ControlledUpgrade): void => {
        this.#upgrade = upgrade;
    };

    /** The release the computer's daemon runs, as `morty --version` reports it. */
    readonly daemonRelease = (): DaemonRelease => this.#release;

    // Like `morty upgrade`: the running daemon switches to the newest release, and
    // its active connections come back on it.
    async #upgradeDaemon(signal: AbortSignal): Promise<void> {
        const cancelled = (): Promise<never> =>
            new Promise<never>((_resolve, reject) => {
                signal.throwIfAborted();
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
        switch (this.#upgrade) {
            case "unavailable":
                this.#upgradeRequested.resolve();
                throw new Error("npm could not return a valid latest Morty version");
            case "unresponsive":
                // A download that never finishes: only cancellation ends it.
                this.#upgradeRequested.resolve();
                return await cancelled();
            case "interrupted-switch": {
                // The manager has stopped the old worker and keeps starting the new one
                // after the CLI stops waiting, so the Computer comes back on its own.
                const switching = this.#switchRelease(signal);
                this.#pendingSwitch = switching;
                await this.#switchStarted.promise;
                this.#upgradeRequested.resolve();
                return await cancelled();
            }
            case "available":
                break;
            default:
                return this.#upgrade satisfies never;
        }
        await this.#switchRelease(signal);
    }

    readonly #switchStarted = Promise.withResolvers<void>();
    #pendingSwitch: Promise<void> = Promise.resolve();

    // Stops the running daemon and brings its connections back on the latest release.
    async #switchRelease(signal: AbortSignal): Promise<void> {
        if (this.#release === "latest") {
            this.#switchStarted.resolve();
            return;
        }
        this.#release = "latest";
        const reconnecting = Array.from(this.#active.keys(), (id) => this.#saved.get(id)).filter(
            (connection) => connection !== undefined,
        );
        await this.disconnect();
        this.#switchStarted.resolve();
        // The switch belongs to the manager, so it outlives the upgrade command's signal.
        for (const connection of reconnecting) {
            await this.#connect(
                connection,
                this.#upgrade === "interrupted-switch" ? new AbortController().signal : signal,
            );
        }
    }

    /**
     * Like the manager's daemon, a connection runs in the background: the command that starts it can be cancelled,
     * but only `disconnect` stops the daemon once it runs.
     */
    async #connect(connection: Connection, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        if (this.#active.has(connection.pairingGeneration)) {
            return;
        }
        const daemon = await connectControlledAgentRuntime({
            behavior: this.#options,
            connection: {
                computerId: connection.computer_id,
                origin: connection.origin,
                credentials: this.#savedCredentials(connection.pairingGeneration),
            },
            signal: new AbortController().signal,
        });
        this.#active.set(connection.pairingGeneration, daemon);
        void daemon.failure.catch((error: unknown) => {
            if (this.#active.get(connection.pairingGeneration) !== daemon) {
                return;
            }
            // Like the manager's daemon, a revoked Computer stops its own connection and the others keep running.
            if (Reflect.get(Object(error), "code") === "computer_relay_revoked") {
                this.#active.delete(connection.pairingGeneration);
                return;
            }
            this.#failed.reject(error);
        });
    }

    #savedCredentials(pairingGeneration: string): ComputerCredentials {
        const credentials = this.#credentials.get(pairingGeneration);
        if (credentials === undefined) {
            throw new Error("The saved connection has no Computer credential");
        }
        return credentials;
    }

    readonly disconnect = async (): Promise<void> => {
        // A switch the manager is finishing completes before its connections stop.
        const switching = this.#pendingSwitch;
        this.#pendingSwitch = Promise.resolve();
        await switching.catch(() => undefined);
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

    /** Disconnects the real relay while retaining the daemon's persisted sessions for recovery. */
    readonly pause = async (): Promise<void> => {
        await Promise.all(Array.from(this.#active.values(), (daemon) => daemon.disconnect()));
    };

    readonly resume = async (): Promise<void> => {
        await Promise.all(Array.from(this.#active.values(), (daemon) => daemon.reconnect()));
    };

    /** Simulates the manager forgetting every saved Computer connection. */
    readonly forgetConnections = async (): Promise<void> => {
        await this.disconnect();
        this.#saved.clear();
        this.#credentials.clear();
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
