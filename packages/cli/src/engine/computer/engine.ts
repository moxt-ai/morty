import { resolve } from "node:path";
import { waitForSharedOperation } from "../session/manager/operation-drain.ts";
import {
    ComputerLoop,
    type ComputerLoopOptions,
    type MortyComputerConnection,
    prepareProvidedComputer,
} from "./computer-loop.ts";
import type { VerifiedComputerConnection } from "./connection/computer-connection.ts";
import { ComputerInstallationStore } from "./connection/computer-installation-store.ts";
import { ConnectionManager } from "./connection/connection-manager.ts";
import { type MortyComputerPairingOptions, pairComputerConnection, prepareComputerConnection } from "./pairing.ts";

export interface MortyComputerEngineParams {
    readonly engineDataDir: string;
    readonly agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly maxAcpProcesses?: number;
}

export type EngineLoopConnection =
    | { readonly kind: "saved"; readonly pairingGeneration: string }
    | { readonly kind: "provided"; readonly connection: MortyComputerConnection };

export interface RunLoopParams extends ComputerLoopOptions {
    readonly connection: EngineLoopConnection;
    readonly signal: AbortSignal;
}

type InstallationState =
    | { readonly kind: "uninitialized" }
    | { readonly kind: "initializing"; readonly completion: Promise<void> }
    | { readonly kind: "ready"; readonly installation: ComputerInstallationStore };

export class MortyComputerEngine {
    readonly #engineDataDir: string;
    readonly #agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly #maxAcpProcesses: number;
    readonly #connections: ConnectionManager;
    #installation: InstallationState = { kind: "uninitialized" };

    constructor(params: MortyComputerEngineParams) {
        this.#engineDataDir = resolve(params.engineDataDir);
        this.#agentLaunchEnvironment = Object.freeze({ ...params.agentLaunchEnvironment });
        this.#maxAcpProcesses = params.maxAcpProcesses ?? 1000;
        this.#connections = new ConnectionManager(this.#ensureInstallation);
    }

    readonly #ensureInstallation = async (signal: AbortSignal): Promise<ComputerInstallationStore> => {
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
                    const installation = await ComputerInstallationStore.open(this.#engineDataDir, signal);
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

    readonly getConnectionManager = (): ConnectionManager => this.#connections;

    readonly pair = async (
        input: MortyComputerPairingOptions,
        signal: AbortSignal,
    ): Promise<VerifiedComputerConnection> =>
        await pairComputerConnection(
            await this.#ensureInstallation(signal),
            input,
            signal,
            this.#agentLaunchEnvironment,
        );

    readonly runLoop = async ({ connection, signal, ...options }: RunLoopParams): Promise<void> => {
        const loop = new ComputerLoop(async (preparationSignal) => {
            const installation = await this.#ensureInstallation(preparationSignal);
            switch (connection.kind) {
                case "saved": {
                    const saved = await installation.readConnection(connection.pairingGeneration, preparationSignal);
                    return await prepareComputerConnection(
                        installation,
                        saved,
                        preparationSignal,
                        this.#agentLaunchEnvironment,
                        this.#maxAcpProcesses,
                    );
                }
                case "provided":
                    return await prepareProvidedComputer({
                        installation,
                        connection: connection.connection,
                        signal: preparationSignal,
                        agentLaunchEnvironment: this.#agentLaunchEnvironment,
                        maxAcpProcesses: this.#maxAcpProcesses,
                    });
                default: {
                    const exhaustive: never = connection;
                    return exhaustive;
                }
            }
        }, options);
        await loop.run(signal);
    };
}

export type { MortyComputerConnection } from "./computer-loop.ts";
export type { ComputerConnectionInput, VerifiedComputerConnection } from "./connection/computer-connection.ts";
export type { ComputerCredentialRotation, ComputerCredentials } from "./connection/computer-credentials.ts";
export type { ConnectionManager } from "./connection/connection-manager.ts";
export type { MortyComputerPairingOptions } from "./pairing.ts";
export { ComputerRelayRevokedError } from "./relay/computer-revocation.ts";
