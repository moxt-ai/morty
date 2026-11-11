import type { RuntimeUpgradeResult } from "@morty-build/client/protocol";
import type { RuntimeAgentProcesses } from "../session/process/runtime-agent-processes.ts";
import type { RuntimeConfig } from "./config.ts";
import { runRuntime } from "./run.ts";

class MortyRuntimeConfigurationError extends Error {
    readonly code = "runtime_configuration_invalid";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "MortyRuntimeConfigurationError";
    }
}

type RuntimeLoopState =
    | { readonly kind: "created" }
    | { readonly kind: "preparing" }
    | { readonly kind: "running" }
    | { readonly kind: "finished" };

function validateComputerRelay(relayUrl: URL): void {
    if (relayUrl.protocol !== "ws:" && relayUrl.protocol !== "wss:") {
        throw new MortyRuntimeConfigurationError("The Runtime relay URL must use WebSocket transport");
    }
    if (relayUrl.username.length > 0 || relayUrl.password.length > 0 || relayUrl.search.length > 0) {
        throw new MortyRuntimeConfigurationError("The Runtime relay URL cannot carry credentials");
    }
}

/** Internal, single-execution owner. Never exported from the package's public API. */
export class RuntimeLoop {
    readonly #prepare: (signal: AbortSignal) => Promise<RuntimeConfig>;
    readonly #options: RuntimeLoopOptions;
    #state: RuntimeLoopState = { kind: "created" };

    constructor(prepare: (signal: AbortSignal) => Promise<RuntimeConfig>, options: RuntimeLoopOptions = {}) {
        this.#prepare = prepare;
        this.#options = options;
    }

    readonly run = async (signal: AbortSignal): Promise<void> => {
        if (this.#state.kind !== "created") {
            throw new MortyRuntimeConfigurationError("A Runtime loop can only be started once");
        }
        signal.throwIfAborted();
        // Claim this execution before asynchronous preparation can yield.
        this.#state = { kind: "preparing" };
        try {
            const prepared = await this.#prepare(signal);
            signal.throwIfAborted();
            const config =
                this.#options.sessionEnvironment === undefined
                    ? prepared
                    : { ...prepared, sessionEnvironment: this.#options.sessionEnvironment };
            validateComputerRelay(config.relayUrl);
            this.#state = { kind: "running" };
            await runRuntime(config, signal, undefined, {
                ...(this.#options.agentProcesses === undefined ? {} : { agentProcesses: this.#options.agentProcesses }),
                onExecutionCountChange: (count) => {
                    this.#options.onExecutionCountChange?.(count);
                },
                ...(this.#options.onConnectionStatus === undefined
                    ? {}
                    : { onConnectionStatus: this.#options.onConnectionStatus }),
                ...(this.#options.reportUpgradeAvailability === undefined
                    ? {}
                    : { reportUpgradeAvailability: this.#options.reportUpgradeAvailability }),
                ...(this.#options.processLogsDirectory === undefined
                    ? {}
                    : { processLogsDirectory: this.#options.processLogsDirectory }),
            });
        } finally {
            this.#state = { kind: "finished" };
            this.#options.onExecutionCountChange?.(0);
        }
    };
}

export interface RuntimeLoopOptions {
    /** Session-scoped Agent environment for this execution only; never persisted with the connection. */
    readonly sessionEnvironment?: RuntimeConfig["sessionEnvironment"];
    readonly agentProcesses?: RuntimeAgentProcesses;
    readonly onConnectionStatus?: (status: "online" | "reconnecting") => void;
    readonly onExecutionCountChange?: (count: number) => void;
    /** Reports a finished daemon upgrade to the relay. The daemon worker supplies it. */
    readonly reportUpgradeAvailability?: (
        send: (result: RuntimeUpgradeResult) => void,
        signal: AbortSignal,
    ) => Promise<void>;
    /**
     * State directory of the daemon processes supervising this Runtime. Passed
     * through to `runRuntime` so the local bug-report log can read the
     * manager-written worker lifecycle and unhandled-rejection logs. Read-only.
     */
    readonly processLogsDirectory?: string;
}
