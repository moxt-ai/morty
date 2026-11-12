import type { RuntimeInstallationStore } from "../../engine/runtime/connection/runtime-installation-store.ts";
import { type MortyComputerPairingOptions, pairComputerConnection } from "../../engine/runtime/pairing.ts";
import { reloadDaemon } from "./daemon.ts";
import { ensureDaemon, type RunningDaemon } from "./daemon-client.ts";

/** Activates the installation's current pairing and has a daemon serve it, starting one when none runs. */
export async function serveCurrentPairing(
    installation: RuntimeInstallationStore,
    entry: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<RunningDaemon> {
    const pairing = await installation.currentConnection(signal);
    if (pairing !== null) {
        await installation.setConnectionActivation(pairing.pairingGeneration, "active", signal);
    }
    const daemon = await ensureDaemon(installation.stateDirectory, entry, environment, signal);
    await reloadDaemon(installation.stateDirectory, signal);
    return daemon;
}

/** Redeems a pairing the browser offered this computer, saves its connection, and has the daemon serve it. */
export async function pairThisComputer(
    installation: RuntimeInstallationStore,
    pairing: MortyComputerPairingOptions,
    entry: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<void> {
    await ensureDaemon(installation.stateDirectory, entry, environment, signal);
    const paired = await pairComputerConnection(installation, pairing, signal, environment);
    await installation.setConnectionActivation(paired.pairingGeneration, "active", signal);
    await reloadDaemon(installation.stateDirectory, signal);
}
