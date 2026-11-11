import { resolve } from "node:path";
import { waitForSharedOperation } from "../session/manager/operation-drain.ts";
import type { VerifiedComputerConnection } from "./connection/computer-connection.ts";
import { RuntimeInstallationStore } from "./connection/runtime-installation-store.ts";
import { type MortyRuntimePairingOptions, pairRuntimeConnection, prepareRuntimeConnection } from "./pairing.ts";
import { RuntimeLoop, type RuntimeLoopOptions } from "./runtime-loop.ts";

export interface MortyRuntimeEngineParams {
    readonly engineDataDir: string;
    readonly agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly maxAcpProcesses?: number;
}

export interface RunLoopParams extends RuntimeLoopOptions {
    readonly pairingGeneration: string;
    readonly signal: AbortSignal;
}

type InstallationState =
    | { readonly kind: "uninitialized" }
    | { readonly kind: "initializing"; readonly completion: Promise<void> }
    | { readonly kind: "ready"; readonly installation: RuntimeInstallationStore };

export class MortyRuntimeEngine {
    readonly #engineDataDir: string;
    readonly #agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly #maxAcpProcesses: number;
    #installation: InstallationState = { kind: "uninitialized" };

    constructor(params: MortyRuntimeEngineParams) {
        this.#engineDataDir = resolve(params.engineDataDir);
        this.#agentLaunchEnvironment = Object.freeze({ ...params.agentLaunchEnvironment });
        this.#maxAcpProcesses = params.maxAcpProcesses ?? 1000;
    }

    readonly #ensureInstallation = async (signal: AbortSignal): Promise<RuntimeInstallationStore> => {
        signal.throwIfAborted();
        const state = this.#installation;
        switch (state.kind) {
            case "ready":
                return state.installation;
            case "initializing":
                // A borrower can stop waiting without cancelling the owner. If the owner
                // fails or cancels, a surviving borrower can become the next initializer.
                await waitForSharedOperation(state.completion, signal);
                return await this.#ensureInstallation(signal);
            case "uninitialized": {
                const completion = Promise.withResolvers<void>();
                // Claim initialization before the first filesystem await. Exclusive file
                // creation alone does not prevent another opener from reading partial JSON.
                this.#installation = { kind: "initializing", completion: completion.promise };
                try {
                    const installation = await RuntimeInstallationStore.open(this.#engineDataDir, signal);
                    signal.throwIfAborted();
                    this.#installation = { kind: "ready", installation };
                    return installation;
                } catch (cause) {
                    this.#installation = { kind: "uninitialized" };
                    signal.throwIfAborted();
                    throw cause;
                } finally {
                    completion.resolve();
                }
            }
            default: {
                const exhaustive: never = state;
                return exhaustive;
            }
        }
    };

    readonly pair = async (
        input: MortyRuntimePairingOptions,
        signal: AbortSignal,
    ): Promise<VerifiedComputerConnection> =>
        await pairRuntimeConnection(
            await this.#ensureInstallation(signal),
            input,
            signal,
            this.#agentLaunchEnvironment,
        );

    readonly runLoop = async ({ pairingGeneration, signal, ...options }: RunLoopParams): Promise<void> => {
        const loop = new RuntimeLoop(async (preparationSignal) => {
            const installation = await this.#ensureInstallation(preparationSignal);
            const saved = await installation.readConnection(pairingGeneration, preparationSignal);
            return await prepareRuntimeConnection(
                installation,
                saved,
                preparationSignal,
                this.#agentLaunchEnvironment,
                this.#maxAcpProcesses,
            );
        }, options);
        await loop.run(signal);
    };
}

export type { VerifiedComputerConnection } from "./connection/computer-connection.ts";

export type { MortyRuntimePairingOptions } from "./pairing.ts";
