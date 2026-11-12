import type { AgentProcessPool } from "../session/process/agent-process-pool.ts";
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
            const config = await this.#prepare(signal);
            signal.throwIfAborted();
            validateComputerRelay(config.relayUrl);
            this.#state = { kind: "running" };
            await runRuntime(config, signal, undefined, {
                ...(this.#options.processes === undefined ? {} : { processes: this.#options.processes }),
                onExecutionCountChange: (count) => {
                    this.#options.onExecutionCountChange?.(count);
                },
                ...(this.#options.onConnectionStatus === undefined
                    ? {}
                    : { onConnectionStatus: this.#options.onConnectionStatus }),
            });
        } finally {
            this.#state = { kind: "finished" };
            this.#options.onExecutionCountChange?.(0);
        }
    };
}

export interface RuntimeLoopOptions {
    readonly processes?: AgentProcessPool;
    readonly onConnectionStatus?: (status: "online" | "reconnecting") => void;
    readonly onExecutionCountChange?: (count: number) => void;
}
