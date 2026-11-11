import { resolve } from "node:path";
import type { ComputerUpgradeResult } from "@morty-build/client/protocol";
import { ComputerAgentDependencies } from "../agent/computer-agents.ts";
import { supportedLocalAgentSpecifications } from "../agent/discovery/discover-local-agents.ts";
import type { ComputerAgentProcesses } from "../session/process/computer-agent-processes.ts";
import type { ComputerTurnActivity } from "../session/turn/computer-turn-activity.ts";
import { ensureCanonicalDirectory } from "../storage/files/local-files.ts";
import { discoverComputerAgentInventory } from "./catalog/discover-agent-catalog.ts";
import { publishAgentCatalog } from "./catalog/publish-agent-catalog.ts";
import { createCatalogAgentResolver } from "./catalog/resolve-catalog-agent.ts";
import { type ComputerConfig, ComputerLocalContext, createComputerConfig } from "./config.ts";
import type { ComputerCredentials } from "./connection/computer-credentials.ts";
import type { ComputerInstallationStore } from "./connection/computer-installation-store.ts";
import { runComputer } from "./run.ts";

const COMPUTER_CREDENTIAL_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;

export interface MortyComputerConnection {
    readonly computerId: string;
    readonly defaultWorkspace: string;
    readonly relayUrl: string;
    /** The embedding host keeps the credential, which rotates on every connection, where it outlives this process. */
    readonly credentials: ComputerCredentials;
}

class MortyComputerConfigurationError extends Error {
    readonly code = "computer_configuration_invalid";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "MortyComputerConfigurationError";
    }
}

type ComputerLoopState =
    | { readonly kind: "created" }
    | { readonly kind: "preparing" }
    | { readonly kind: "running"; readonly config: ComputerConfig }
    | { readonly kind: "finished" };

function validateComputerRelay(relayUrl: URL): void {
    if (relayUrl.protocol !== "ws:" && relayUrl.protocol !== "wss:") {
        throw new MortyComputerConfigurationError("The Computer relay URL must use WebSocket transport");
    }
    if (relayUrl.username.length > 0 || relayUrl.password.length > 0 || relayUrl.search.length > 0) {
        throw new MortyComputerConfigurationError("The Computer relay URL cannot carry credentials");
    }
}

function validateComputerConfiguration(config: ComputerConfig): void {
    validateComputerRelay(config.relayUrl);
}

function relayUrlFromConnection(connection: MortyComputerConnection): URL {
    let relayUrl: URL;
    try {
        relayUrl = new URL(connection.relayUrl);
    } catch (error) {
        throw new MortyComputerConfigurationError("The Computer relay URL is invalid", { cause: error });
    }
    validateComputerRelay(relayUrl);
    return relayUrl;
}

async function validateComputerCredentials(credentials: ComputerCredentials, signal: AbortSignal): Promise<void> {
    if (!COMPUTER_CREDENTIAL_PATTERN.test((await credentials.held(signal)).current)) {
        throw new MortyComputerConfigurationError("The Computer relay credential is invalid");
    }
}

async function resolveWorkspace(path: string): Promise<string> {
    const requested = resolve(path);
    let resolved: string | null;
    try {
        resolved = await ensureCanonicalDirectory(requested);
    } catch (error) {
        throw new MortyComputerConfigurationError("The Computer workspace cannot be resolved", { cause: error });
    }
    if (resolved === null) {
        throw new MortyComputerConfigurationError("The Computer workspace is not a directory");
    }
    return resolved;
}

interface PrepareProvidedComputerParams {
    readonly installation: ComputerInstallationStore;
    readonly connection: MortyComputerConnection;
    readonly signal: AbortSignal;
    readonly agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly maxAcpProcesses: number;
}

export async function prepareProvidedComputer({
    installation,
    connection,
    signal,
    agentLaunchEnvironment,
    maxAcpProcesses,
}: PrepareProvidedComputerParams): Promise<ComputerConfig> {
    signal.throwIfAborted();
    const relayUrl = relayUrlFromConnection(connection);
    await validateComputerCredentials(connection.credentials, signal);
    const localContext = new ComputerLocalContext(installation.stateDirectory, agentLaunchEnvironment, maxAcpProcesses);
    const defaultWorkspace = await resolveWorkspace(connection.defaultWorkspace);
    const specifications = supportedLocalAgentSpecifications();
    const discoveryEnvironment = localContext.agentLaunchEnvironment;
    const discover = async (refreshSignal: AbortSignal) =>
        await discoverComputerAgentInventory(
            {
                defaultWorkspace,
                dataDirectory: localContext.stateDirectory,
                environment: discoveryEnvironment,
                signal: refreshSignal,
                specifications,
            },
            connection.computerId,
        );
    const inventory = await discover(signal);
    const config: ComputerConfig = createComputerConfig(
        {
            computerId: connection.computerId,
            defaultWorkspace,
            relayUrl,
            credentials: connection.credentials,
        },
        new ComputerAgentDependencies(inventory.readyAgents()),
        localContext,
        null,
        createCatalogAgentResolver(
            (refreshSignal) => discover(refreshSignal),
            () => config,
            publishAgentCatalog,
        ),
        (refreshSignal: AbortSignal) => discover(refreshSignal).then((inventory) => inventory.readyAgents()),
    );
    return config;
}

/** Internal, single-execution owner. Never exported from the package's public API. */
export class ComputerLoop {
    readonly #prepare: (signal: AbortSignal) => Promise<ComputerConfig>;
    readonly #options: ComputerLoopOptions;
    #state: ComputerLoopState = { kind: "created" };

    constructor(prepare: (signal: AbortSignal) => Promise<ComputerConfig>, options: ComputerLoopOptions = {}) {
        this.#prepare = prepare;
        this.#options = options;
    }

    readonly run = async (signal: AbortSignal): Promise<void> => {
        if (this.#state.kind !== "created") {
            throw new MortyComputerConfigurationError("A Computer loop can only be started once");
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
            validateComputerConfiguration(config);
            this.#state = { kind: "running", config };
            await runComputer(config, signal, undefined, {
                ...(this.#options.turnActivity === undefined ? {} : { turnActivity: this.#options.turnActivity }),
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

export interface ComputerLoopOptions {
    /** Session-scoped Agent environment for this execution only; never persisted with the connection. */
    readonly sessionEnvironment?: ComputerConfig["sessionEnvironment"];
    readonly turnActivity?: ComputerTurnActivity;
    readonly agentProcesses?: ComputerAgentProcesses;
    readonly onConnectionStatus?: (status: "online" | "reconnecting") => void;
    readonly onExecutionCountChange?: (count: number) => void;
    /** Reports a finished daemon upgrade to the relay. The daemon worker supplies it. */
    readonly reportUpgradeAvailability?: (
        send: (result: ComputerUpgradeResult) => void,
        signal: AbortSignal,
    ) => Promise<void>;
    /**
     * State directory of the daemon processes supervising this Computer. Passed
     * through to `runComputer` so the local bug-report log can read the
     * manager-written worker lifecycle and unhandled-rejection logs. Read-only.
     */
    readonly processLogsDirectory?: string;
}
