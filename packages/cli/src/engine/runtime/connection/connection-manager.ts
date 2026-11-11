import type {
    ComputerConnectionActivation,
    ComputerConnectionInput,
    VerifiedComputerConnection,
} from "./computer-connection.ts";
import type { RuntimeInstallationStore } from "./runtime-installation-store.ts";

/** Saved connections; ensuring the installation exists remains an Engine responsibility. */
export class ConnectionManager {
    readonly #ensureInstallation: (signal: AbortSignal) => Promise<RuntimeInstallationStore>;

    constructor(ensureInstallation: (signal: AbortSignal) => Promise<RuntimeInstallationStore>) {
        this.#ensureInstallation = ensureInstallation;
    }

    readonly list = async (signal: AbortSignal): Promise<readonly VerifiedComputerConnection[]> =>
        await (await this.#ensureInstallation(signal)).listConnections(signal);

    readonly read = async (pairingGeneration: string, signal: AbortSignal): Promise<VerifiedComputerConnection> =>
        await (await this.#ensureInstallation(signal)).readConnection(pairingGeneration, signal);

    readonly save = async (input: ComputerConnectionInput, signal: AbortSignal): Promise<VerifiedComputerConnection> =>
        await (await this.#ensureInstallation(signal)).saveConnection(input, signal);

    readonly setActivation = async (
        pairingGeneration: string,
        activation: ComputerConnectionActivation,
        signal: AbortSignal,
    ): Promise<VerifiedComputerConnection> =>
        await (await this.#ensureInstallation(signal)).setConnectionActivation(pairingGeneration, activation, signal);

    readonly remove = async (pairingGeneration: string, signal: AbortSignal): Promise<void> =>
        await (await this.#ensureInstallation(signal)).removeConnection(pairingGeneration, signal);
}
