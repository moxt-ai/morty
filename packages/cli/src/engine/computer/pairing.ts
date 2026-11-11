import { hostname } from "node:os";
import { basename, resolve } from "node:path";
import { isIdentifier, mortyApiUrl } from "@morty-build/client/protocol";
import { fetch, type Response } from "undici";
import type { CatalogAgent } from "../agent/catalog.ts";
import { ComputerAgentDependencies } from "../agent/computer-agents.ts";
import { discoverLocalAgentInventory, type LocalAgentInventory } from "../agent/discovery/discover-local-agents.ts";
import { ensureCanonicalDirectory } from "../storage/files/local-files.ts";
import { environmentProxyDispatcher } from "../util/network/environment-proxy.ts";
import { isRecord } from "../util/value-utils.ts";
import { discoverComputerAgentInventory } from "./catalog/discover-agent-catalog.ts";
import { publishAgentCatalog } from "./catalog/publish-agent-catalog.ts";
import { createCatalogAgentResolver } from "./catalog/resolve-catalog-agent.ts";
import { type ComputerConfig, ComputerLocalContext, createComputerConfig } from "./config.ts";
import type { VerifiedComputerConnection } from "./connection/computer-connection.ts";
import type { ComputerCredentials } from "./connection/computer-credentials.ts";
import type { ComputerInstallationStore } from "./connection/computer-installation-store.ts";

const PAIRING_TIMEOUT_MILLISECONDS = 20_000;
const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;

const REDEEM_RESPONSE_KEYS = ["computerId", "computerCredential"] as const;

interface PairCommandOptions {
    readonly code: string;
    readonly computerId: string;
    readonly relayOrigin: URL;
    readonly workspace: string;
}

interface ClaimPairingResponse {
    readonly computerId: string;
    readonly computerCredential: string;
}

export interface MortyComputerPairingOptions {
    readonly defaultWorkspace: string;
    readonly pairingCode: string;
    readonly computerId: string;
    readonly relayOrigin: string;
}

export class PairingClientError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "PairingClientError";
    }
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expectedKeys: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

export function parseRelayOrigin(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch (error) {
        throw new PairingClientError("invalid_relay_url", "The relay URL is invalid", { cause: error });
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new PairingClientError("invalid_relay_url", "The relay URL must use http or https");
    }
    if (url.username.length > 0 || url.password.length > 0) {
        throw new PairingClientError("invalid_relay_url", "The relay URL cannot contain credentials");
    }
    if (url.protocol === "http:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        throw new PairingClientError("invalid_relay_url", "A remote relay must use https");
    }
    url.hash = "";
    url.pathname = "/";
    url.search = "";
    return url;
}

export function parsePairingCode(value: string): string {
    const code = value.trim().toUpperCase();
    if (!PAIRING_CODE_PATTERN.test(code)) {
        throw new PairingClientError(
            "invalid_pairing_code",
            "The pairing code must match the code shown in the browser",
        );
    }
    return code;
}

export function validateComputerId(value: string): string {
    if (!isIdentifier(value)) {
        throw new PairingClientError("invalid_computer_id", "The Computer pairing ID is invalid");
    }
    return value;
}

async function resolveDefaultWorkspace(path: string): Promise<string> {
    const requestedWorkspace = resolve(path);
    let defaultWorkspace: string | null;
    try {
        defaultWorkspace = await ensureCanonicalDirectory(requestedWorkspace);
    } catch (error) {
        throw new PairingClientError("invalid_workspace", "The default workspace cannot be resolved", { cause: error });
    }
    if (defaultWorkspace === null) {
        throw new PairingClientError("invalid_workspace", "The default workspace is not a directory");
    }
    return defaultWorkspace;
}

async function readJsonResponse(response: Response): Promise<unknown> {
    if (response.headers.get("cf-mitigated") === "challenge") {
        throw new PairingClientError(
            "relay_challenge",
            "Cloudflare is protecting this temporary preview. Claim the deployment or use an authenticated deployment, then pair again",
        );
    }
    const encoded = await response.text();
    try {
        return JSON.parse(encoded);
    } catch (error) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid response", {
            cause: error,
        });
    }
}

function readRelayError(value: unknown): PairingClientError {
    if (isRecord(value)) {
        const error = value["error"];
        if (isRecord(error)) {
            const code = error["code"];
            const message = error["message"];
            if (typeof code === "string" && typeof message === "string") {
                return new PairingClientError(code, message);
            }
        }
    }
    return new PairingClientError("pairing_failed", "The relay could not pair this machine");
}

function decodePairingResponse(value: unknown): ClaimPairingResponse {
    if (!isRecord(value) || !hasExactKeys(value, REDEEM_RESPONSE_KEYS)) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid pairing response");
    }
    const computerCredential = value["computerCredential"];
    const computerId = value["computerId"];
    if (
        typeof computerId !== "string" ||
        !isIdentifier(computerId) ||
        typeof computerCredential !== "string" ||
        !TOKEN_PATTERN.test(computerCredential)
    ) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid pairing response");
    }
    return { computerId, computerCredential };
}

async function claimPairing(
    options: PairCommandOptions,
    defaultWorkspace: string,
    localAgents: readonly CatalogAgent[],
    signal: AbortSignal,
): Promise<ClaimPairingResponse> {
    const agents = localAgents.map((agent) => ({
        agentPath: agent.agentIdentity.requestedPath,
        agentVersion: agent.agentVersion,
        capabilities: agent.capabilities,
        harness: agent.harness,
        label: agent.label,
    }));
    const endpoint = mortyApiUrl(options.relayOrigin, `/v1/pairings/${encodeURIComponent(options.computerId)}/redeem`);
    let response: Response;
    try {
        response = await fetch(endpoint, {
            body: JSON.stringify({
                agents,
                machineName: hostname(),
                pairingCode: options.code,
                workspaceName: basename(defaultWorkspace) || "Local workspace",
            }),
            dispatcher: environmentProxyDispatcher,
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.any([signal, AbortSignal.timeout(PAIRING_TIMEOUT_MILLISECONDS)]),
        });
    } catch (error) {
        signal.throwIfAborted();
        throw new PairingClientError("relay_unavailable", "The pairing relay could not be reached", { cause: error });
    }

    const value = await readJsonResponse(response);
    if (!response.ok) {
        throw readRelayError(value);
    }
    return decodePairingResponse(value);
}

function buildSavedComputerConfig(
    connection: VerifiedComputerConnection,
    credentials: ComputerCredentials,
    defaultWorkspace: string,
    inventory: LocalAgentInventory,
    localContext: ComputerLocalContext,
): ComputerConfig {
    const relayUrl = mortyApiUrl(connection.relayOrigin, "/v1/computers/connect");
    relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";

    const config: ComputerConfig = createComputerConfig(
        {
            defaultWorkspace,
            computerId: connection.computerId,
            relayUrl,
            credentials,
        },
        new ComputerAgentDependencies(inventory.readyAgents()),
        localContext,
        { kind: "managed" },
        createCatalogAgentResolver(
            (refreshSignal) =>
                discoverComputerAgentInventory(
                    {
                        defaultWorkspace,
                        dataDirectory: localContext.stateDirectory,
                        environment: localContext.agentLaunchEnvironment,
                        signal: refreshSignal,
                    },
                    connection.computerId,
                ),
            () => config,
            publishAgentCatalog,
        ),
        (refreshSignal: AbortSignal) =>
            discoverComputerAgentInventory(
                {
                    defaultWorkspace,
                    dataDirectory: localContext.stateDirectory,
                    environment: localContext.agentLaunchEnvironment,
                    signal: refreshSignal,
                },
                connection.computerId,
            ).then((inventory) => inventory.readyAgents()),
    );
    return config;
}

async function pairComputer(
    installation: ComputerInstallationStore,
    options: PairCommandOptions,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<VerifiedComputerConnection> {
    const localContext = new ComputerLocalContext(installation.stateDirectory, environment);
    const defaultWorkspace = await resolveDefaultWorkspace(options.workspace);
    const inventory = await discoverLocalAgentInventory({
        defaultWorkspace,
        dataDirectory: localContext.stateDirectory,
        environment: localContext.agentLaunchEnvironment,
        signal,
    });
    const claim = await claimPairing(options, defaultWorkspace, inventory.readyAgents(), signal);
    const connection = await installation.saveConnection(
        {
            computerId: claim.computerId,
            defaultWorkspace,
            relayOrigin: options.relayOrigin,
            computerCredential: claim.computerCredential,
        },
        signal,
    );
    return connection;
}

export async function pairComputerConnection(
    installation: ComputerInstallationStore,
    options: MortyComputerPairingOptions,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<VerifiedComputerConnection> {
    return await pairComputer(
        installation,
        {
            code: parsePairingCode(options.pairingCode),
            computerId: validateComputerId(options.computerId),
            relayOrigin: parseRelayOrigin(options.relayOrigin),
            workspace: options.defaultWorkspace,
        },
        signal,
        environment,
    );
}

export async function prepareComputerConnection(
    installation: ComputerInstallationStore,
    connection: VerifiedComputerConnection,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
    maxAcpProcesses: number,
): Promise<ComputerConfig> {
    const localContext = new ComputerLocalContext(installation.stateDirectory, environment, maxAcpProcesses);
    const defaultWorkspace = await resolveDefaultWorkspace(connection.defaultWorkspace);
    const inventory = await discoverComputerAgentInventory(
        {
            defaultWorkspace,
            dataDirectory: localContext.stateDirectory,
            environment: localContext.agentLaunchEnvironment,
            signal,
        },
        connection.computerId,
    );
    return buildSavedComputerConfig(
        connection,
        installation.computerCredentials(connection.pairingGeneration),
        defaultWorkspace,
        inventory,
        localContext,
    );
}
