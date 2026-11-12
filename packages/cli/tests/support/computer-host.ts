import type { SavedComputerConnection } from "../../src/engine/runtime/connection/computer-connection.ts";
import { RuntimeInstallationStore } from "../../src/engine/runtime/connection/runtime-installation-store.ts";
import {
    type MortyComputerPairingOptions,
    pairComputerConnection,
    prepareComputerConnection,
} from "../../src/engine/runtime/pairing.ts";
import { type RunRuntimeOptions, runRuntime } from "../../src/engine/runtime/run.ts";

/**
 * Pairs and serves a Computer from an explicit data directory through the production pairing, preparation and
 * Runtime the daemon composes, for tests that drive a Runtime without a daemon process.
 */
export class TestComputerHost {
    readonly #dataDirectory: string;
    readonly #agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    #installation: Promise<RuntimeInstallationStore> | undefined;

    constructor(params: {
        readonly dataDirectory: string;
        readonly agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    }) {
        this.#dataDirectory = params.dataDirectory;
        this.#agentLaunchEnvironment = Object.freeze({ ...params.agentLaunchEnvironment });
    }

    readonly #open = (signal: AbortSignal): Promise<RuntimeInstallationStore> => {
        this.#installation ??= RuntimeInstallationStore.open(this.#dataDirectory, signal);
        return this.#installation;
    };

    readonly pair = async (input: MortyComputerPairingOptions, signal: AbortSignal): Promise<SavedComputerConnection> =>
        await pairComputerConnection(await this.#open(signal), input, signal, this.#agentLaunchEnvironment);

    readonly runLoop = async ({
        pairingGeneration,
        signal,
        ...options
    }: RunRuntimeOptions & { readonly pairingGeneration: string; readonly signal: AbortSignal }): Promise<void> => {
        const installation = await this.#open(signal);
        const saved = await installation.readConnection(pairingGeneration, signal);
        const config = await prepareComputerConnection(installation, saved, signal, this.#agentLaunchEnvironment);
        await runRuntime(config, signal, undefined, options);
    };
}
