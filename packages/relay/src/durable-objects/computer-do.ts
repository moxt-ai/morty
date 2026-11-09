import { DurableObject } from "cloudflare:workers";
import {
    type AccessGrantRedemption,
    type ClaimPairing,
    type CreateAccessGrant,
    type CreateBrowserCredential,
    DurableObjectDatabaseAdapter,
    type RedeemAccessGrant,
    type RequestRuntimePairing,
    type RevokeRuntime,
    type RuntimePairingRequest,
} from "@morty-build/relay-core";
import { applyDurableObjectMigrations } from "@morty-build/relay-core/durable-object-migrations";
import { logger } from "@morty-build/relay-core/logging";
import { decodeComputerDurableObjectPath } from "../entity/computer-durable-object-path.ts";
import { decodeComputerPlacement } from "../entity/computer-id.ts";
import type { PlatformAuditRecord, ProjectAuditRow } from "../entity/platform-records.ts";
import { computerDurableObjectMigrations } from "../generated/project-do-migrations.ts";
import type { PlatformProjectStore } from "../infra/platform-project-store.ts";
import {
    type ComputerPlatformRelayBindings,
    type ConfiguredPlatformRelayBindings,
    createPlatformWorker,
} from "../platform-worker.ts";
import { ComputerObjectIdentityStorage } from "../storage/project-object-identity-storage.ts";
import { SqlitePlatformProjectStore } from "../storage/sqlite-platform-project-store.ts";

type Store = PlatformProjectStore;
type Result<Operation extends keyof Store> = Awaited<ReturnType<Store[Operation]>>;

// Operations run to completion once delivered; a caller that gives up only stops waiting for the result.
const uncancelled = new AbortController().signal;

/**
 * Owns one computer's storage. Requests routed to the computer run here against that storage, and every other
 * Worker or Durable Object reaches it only through the typed operations below, each executed here as one unit.
 */
export class ComputerDO extends DurableObject<ConfiguredPlatformRelayBindings> {
    readonly #application = createPlatformWorker();
    readonly #database: DurableObjectDatabaseAdapter;
    readonly #identity: ComputerObjectIdentityStorage;
    readonly #environment: ConfiguredPlatformRelayBindings;
    readonly #durableObjectId: string;
    #store: Store | null = null;

    constructor(state: DurableObjectState, environment: ConfiguredPlatformRelayBindings) {
        super(state, environment);
        this.#environment = environment;
        this.#durableObjectId = state.id.toString();
        try {
            applyDurableObjectMigrations(state.storage, computerDurableObjectMigrations);
            this.#identity = new ComputerObjectIdentityStorage(state.storage);
            this.#database = new DurableObjectDatabaseAdapter(state.storage);
        } catch (error) {
            logger.error(
                {
                    event: "computer_do_initialization_failed",
                    durableObjectClass: "ComputerDO",
                    durableObjectId: this.#durableObjectId,
                    err: error,
                },
                "Account Durable Object initialization failed",
            );
            throw error;
        }
    }

    /** The store of the computer this object holds; null when `computerId` names another computer. */
    #computerStore(computerId: string): Store | null {
        if (!this.#identity.bind(computerId)) {
            return null;
        }
        this.#store ??= new SqlitePlatformProjectStore(computerId, this.#database);
        return this.#store;
    }

    #operate(computerId: string): Store {
        const store = decodeComputerPlacement(computerId) === null ? null : this.#computerStore(computerId);
        if (store === null) {
            throw new Error("The computer is unavailable");
        }
        return store;
    }

    override async fetch(request: Request): Promise<Response> {
        const requestUrl = new URL(request.url);
        const computerPath = decodeComputerDurableObjectPath(requestUrl.pathname);
        try {
            const placement = computerPath === null ? null : decodeComputerPlacement(computerPath.computerId);
            if (computerPath === null || placement === null) {
                return Response.json(
                    { error: { code: "project_id_invalid", message: "The Project identifier is invalid" } },
                    { status: 400 },
                );
            }
            const computerId = computerPath.computerId;
            const store = this.#computerStore(computerId);
            if (store === null) {
                return Response.json(
                    { error: { code: "project_id_mismatch", message: "The computer is unavailable" } },
                    { status: 421 },
                );
            }
            requestUrl.pathname = computerPath.requestPathname;
            const routedRequest = new Request(requestUrl, request);
            const environment: ConfiguredPlatformRelayBindings & ComputerPlatformRelayBindings = {
                ...this.#environment,
                MORTY_COMPUTER_STORE: store,
                MORTY_COMPUTER_ID: computerId,
            };
            return await this.#application.fetch(routedRequest, environment);
        } catch (error) {
            request.signal.throwIfAborted();
            logger.error(
                {
                    event: "project_do_request_failed",
                    durableObjectClass: "ComputerDO",
                    durableObjectId: this.#durableObjectId,
                    computerId: computerPath?.computerId ?? null,
                    method: request.method,
                    path: computerPath?.requestPathname ?? requestUrl.pathname,
                    cfRay: request.headers.get("cf-ray")?.slice(0, 128) ?? null,
                    err: error,
                },
                "Account Durable Object request failed",
            );
            throw error;
        }
    }

    async authenticateHost(
        computerId: string,
        channelId: string,
        tokenHash: string,
        now: number,
    ): Promise<Result<"authenticateHost">> {
        return await this.#operate(computerId).authenticateHost(channelId, tokenHash, now, uncancelled);
    }

    async isHostCredentialActive(
        computerId: string,
        identity: Parameters<Store["isHostCredentialActive"]>[0],
    ): Promise<boolean> {
        return await this.#operate(computerId).isHostCredentialActive(identity, uncancelled);
    }

    async listLinkedDevices(computerId: string, channelId: string): Promise<Result<"listLinkedDevices">> {
        return await this.#operate(computerId).listLinkedDevices(channelId, uncancelled);
    }

    async revokeLinkedDevice(
        computerId: string,
        channelId: string,
        credentialId: string,
        now: number,
    ): Promise<boolean> {
        return await this.#operate(computerId).revokeLinkedDevice(channelId, credentialId, now, uncancelled);
    }

    async createAccessGrant(computerId: string, value: CreateAccessGrant): Promise<boolean> {
        return await this.#operate(computerId).createAccessGrant(value, uncancelled);
    }

    async redeemAccessGrant(computerId: string, value: RedeemAccessGrant): Promise<AccessGrantRedemption> {
        return await this.#operate(computerId).redeemAccessGrant(value, uncancelled);
    }

    async createBrowserCredential(computerId: string, value: CreateBrowserCredential): Promise<boolean> {
        return await this.#operate(computerId).createBrowserCredential(value, uncancelled);
    }

    async revokeBrowserCredential(computerId: string, credentialId: string, now: number): Promise<boolean> {
        return await this.#operate(computerId).revokeBrowserCredential(credentialId, now, uncancelled);
    }

    async updateAgentCatalog(
        computerId: string,
        channelId: string,
        tokenHash: string,
        agents: string,
    ): Promise<boolean> {
        return await this.#operate(computerId).updateAgentCatalog(channelId, tokenHash, agents, uncancelled);
    }

    async isRuntimeActive(computerId: string, runtimeId: string): Promise<boolean> {
        return await this.#operate(computerId).isRuntimeActive(runtimeId, uncancelled);
    }

    async readRuntime(computerId: string, runtimeId: string): Promise<Result<"readRuntime">> {
        return await this.#operate(computerId).readRuntime(runtimeId, uncancelled);
    }

    async listRuntimes(computerId: string): Promise<Result<"listRuntimes">> {
        return await this.#operate(computerId).listRuntimes(uncancelled);
    }

    async readChannel(computerId: string, channelId: string): Promise<Result<"readChannel">> {
        return await this.#operate(computerId).readChannel(channelId, uncancelled);
    }

    async requestRuntimePairing(computerId: string, value: RequestRuntimePairing): Promise<RuntimePairingRequest> {
        return await this.#operate(computerId).requestRuntimePairing(value, uncancelled);
    }

    async readRuntimePairing(computerId: string, pairingId: string): Promise<Result<"readRuntimePairing">> {
        return await this.#operate(computerId).readRuntimePairing(pairingId, uncancelled);
    }

    async readPairingCode(computerId: string, codeHash: string): Promise<Result<"readPairingCode">> {
        return await this.#operate(computerId).readPairingCode(codeHash, uncancelled);
    }

    async claimPairing(computerId: string, value: ClaimPairing): Promise<boolean> {
        return await this.#operate(computerId).claimPairing(value, uncancelled);
    }

    async revokeRuntime(computerId: string, value: RevokeRuntime): Promise<Result<"revokeRuntime">> {
        return await this.#operate(computerId).revokeRuntime(value, uncancelled);
    }

    async findCredential(
        computerId: string,
        credential: Parameters<Store["findCredential"]>[0],
    ): Promise<Result<"findCredential">> {
        return await this.#operate(computerId).findCredential(credential, uncancelled);
    }

    async rotateRuntimeCredential(
        computerId: string,
        presentedHash: string,
        successorHash: string,
    ): Promise<Result<"rotateRuntimeCredential">> {
        return await this.#operate(computerId).rotateRuntimeCredential(presentedHash, successorHash, uncancelled);
    }

    async recordAudit(computerId: string, audit: PlatformAuditRecord): Promise<void> {
        await this.#operate(computerId).recordAudit(audit, uncancelled);
    }

    async listAuditEvents(computerId: string, limit: number): Promise<readonly ProjectAuditRow[]> {
        return await this.#operate(computerId).listAuditEvents(limit, uncancelled);
    }
}
