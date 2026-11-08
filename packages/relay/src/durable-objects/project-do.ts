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
import { decodePlatformProjectPlacement } from "../entity/platform-project-id.ts";
import type { PlatformAuditRecord, ProjectAuditRow } from "../entity/platform-records.ts";
import { decodeProjectDurableObjectPath } from "../entity/project-durable-object-path.ts";
import { projectDurableObjectMigrations } from "../generated/project-do-migrations.ts";
import type { PlatformProjectStore } from "../infra/platform-project-store.ts";
import {
    type ConfiguredPlatformRelayBindings,
    createPlatformWorker,
    type ProjectPlatformRelayBindings,
} from "../platform-worker.ts";
import { ProjectObjectIdentityStorage } from "../storage/project-object-identity-storage.ts";
import { SqlitePlatformProjectStore } from "../storage/sqlite-platform-project-store.ts";

type Store = PlatformProjectStore;
type Result<Operation extends keyof Store> = Awaited<ReturnType<Store[Operation]>>;

// Operations run to completion once delivered; a caller that gives up only stops waiting for the result.
const uncancelled = new AbortController().signal;

/**
 * Owns one Project's storage. Requests routed to the Project run here against that storage, and every other
 * Worker or Durable Object reaches it only through the typed operations below, each executed here as one unit.
 */
export class ProjectDO extends DurableObject<ConfiguredPlatformRelayBindings> {
    readonly #application = createPlatformWorker();
    readonly #database: DurableObjectDatabaseAdapter;
    readonly #identity: ProjectObjectIdentityStorage;
    readonly #environment: ConfiguredPlatformRelayBindings;
    readonly #durableObjectId: string;
    #store: Store | null = null;

    constructor(state: DurableObjectState, environment: ConfiguredPlatformRelayBindings) {
        super(state, environment);
        this.#environment = environment;
        this.#durableObjectId = state.id.toString();
        try {
            applyDurableObjectMigrations(state.storage, projectDurableObjectMigrations);
            this.#identity = new ProjectObjectIdentityStorage(state.storage);
            this.#database = new DurableObjectDatabaseAdapter(state.storage);
        } catch (error) {
            logger.error(
                {
                    event: "project_do_initialization_failed",
                    durableObjectClass: "ProjectDO",
                    durableObjectId: this.#durableObjectId,
                    err: error,
                },
                "Project Durable Object initialization failed",
            );
            throw error;
        }
    }

    /** The store of the Project this object holds; null when `projectId` names another Project. */
    #projectStore(projectId: string): Store | null {
        if (!this.#identity.bind(projectId)) {
            return null;
        }
        this.#store ??= new SqlitePlatformProjectStore(projectId, this.#database);
        return this.#store;
    }

    #operate(projectId: string): Store {
        const store = decodePlatformProjectPlacement(projectId) === null ? null : this.#projectStore(projectId);
        if (store === null) {
            throw new Error("The Project is unavailable");
        }
        return store;
    }

    override async fetch(request: Request): Promise<Response> {
        const requestUrl = new URL(request.url);
        const projectPath = decodeProjectDurableObjectPath(requestUrl.pathname);
        try {
            const placement = projectPath === null ? null : decodePlatformProjectPlacement(projectPath.projectId);
            if (projectPath === null || placement === null) {
                return Response.json(
                    { error: { code: "project_id_invalid", message: "The Project identifier is invalid" } },
                    { status: 400 },
                );
            }
            const projectId = projectPath.projectId;
            const store = this.#projectStore(projectId);
            if (store === null) {
                return Response.json(
                    { error: { code: "project_id_mismatch", message: "The Project is unavailable" } },
                    { status: 421 },
                );
            }
            requestUrl.pathname = projectPath.requestPathname;
            const routedRequest = new Request(requestUrl, request);
            const environment: ConfiguredPlatformRelayBindings & ProjectPlatformRelayBindings = {
                ...this.#environment,
                MORTY_PROJECT_STORE: store,
                MORTY_PROJECT_ID: projectId,
            };
            return await this.#application.fetch(routedRequest, environment);
        } catch (error) {
            request.signal.throwIfAborted();
            logger.error(
                {
                    event: "project_do_request_failed",
                    durableObjectClass: "ProjectDO",
                    durableObjectId: this.#durableObjectId,
                    projectId: projectPath?.projectId ?? null,
                    method: request.method,
                    path: projectPath?.requestPathname ?? requestUrl.pathname,
                    cfRay: request.headers.get("cf-ray")?.slice(0, 128) ?? null,
                    err: error,
                },
                "Project Durable Object request failed",
            );
            throw error;
        }
    }

    async authenticateHost(
        projectId: string,
        channelId: string,
        tokenHash: string,
        now: number,
    ): Promise<Result<"authenticateHost">> {
        return await this.#operate(projectId).authenticateHost(channelId, tokenHash, now, uncancelled);
    }

    async isHostCredentialActive(
        projectId: string,
        identity: Parameters<Store["isHostCredentialActive"]>[0],
    ): Promise<boolean> {
        return await this.#operate(projectId).isHostCredentialActive(identity, uncancelled);
    }

    async listLinkedDevices(projectId: string, channelId: string): Promise<Result<"listLinkedDevices">> {
        return await this.#operate(projectId).listLinkedDevices(channelId, uncancelled);
    }

    async revokeLinkedDevice(
        projectId: string,
        channelId: string,
        credentialId: string,
        now: number,
    ): Promise<boolean> {
        return await this.#operate(projectId).revokeLinkedDevice(channelId, credentialId, now, uncancelled);
    }

    async createAccessGrant(projectId: string, value: CreateAccessGrant): Promise<boolean> {
        return await this.#operate(projectId).createAccessGrant(value, uncancelled);
    }

    async redeemAccessGrant(projectId: string, value: RedeemAccessGrant): Promise<AccessGrantRedemption> {
        return await this.#operate(projectId).redeemAccessGrant(value, uncancelled);
    }

    async createBrowserCredential(projectId: string, value: CreateBrowserCredential): Promise<boolean> {
        return await this.#operate(projectId).createBrowserCredential(value, uncancelled);
    }

    async revokeBrowserCredential(projectId: string, credentialId: string, now: number): Promise<boolean> {
        return await this.#operate(projectId).revokeBrowserCredential(credentialId, now, uncancelled);
    }

    async readDaemon(projectId: string, channelId: string, tokenHash: string): Promise<Result<"readDaemon">> {
        return await this.#operate(projectId).readDaemon(channelId, tokenHash, uncancelled);
    }

    async updateAgentCatalog(
        projectId: string,
        channelId: string,
        tokenHash: string,
        agents: string,
    ): Promise<boolean> {
        return await this.#operate(projectId).updateAgentCatalog(channelId, tokenHash, agents, uncancelled);
    }

    async isRuntimeActive(projectId: string, runtimeId: string): Promise<boolean> {
        return await this.#operate(projectId).isRuntimeActive(runtimeId, uncancelled);
    }

    async readRuntime(projectId: string, runtimeId: string): Promise<Result<"readRuntime">> {
        return await this.#operate(projectId).readRuntime(runtimeId, uncancelled);
    }

    async listRuntimes(projectId: string): Promise<Result<"listRuntimes">> {
        return await this.#operate(projectId).listRuntimes(uncancelled);
    }

    async readChannel(projectId: string, channelId: string): Promise<Result<"readChannel">> {
        return await this.#operate(projectId).readChannel(channelId, uncancelled);
    }

    async requestRuntimePairing(projectId: string, value: RequestRuntimePairing): Promise<RuntimePairingRequest> {
        return await this.#operate(projectId).requestRuntimePairing(value, uncancelled);
    }

    async readRuntimePairing(projectId: string, pairingId: string): Promise<Result<"readRuntimePairing">> {
        return await this.#operate(projectId).readRuntimePairing(pairingId, uncancelled);
    }

    async readPairingCode(projectId: string, codeHash: string): Promise<Result<"readPairingCode">> {
        return await this.#operate(projectId).readPairingCode(codeHash, uncancelled);
    }

    async claimPairing(projectId: string, value: ClaimPairing): Promise<boolean> {
        return await this.#operate(projectId).claimPairing(value, uncancelled);
    }

    async revokeRuntime(projectId: string, value: RevokeRuntime): Promise<Result<"revokeRuntime">> {
        return await this.#operate(projectId).revokeRuntime(value, uncancelled);
    }

    async findCredential(
        projectId: string,
        credential: Parameters<Store["findCredential"]>[0],
    ): Promise<Result<"findCredential">> {
        return await this.#operate(projectId).findCredential(credential, uncancelled);
    }

    async findRuntimeCredential(projectId: string, tokenHash: string): Promise<Result<"findRuntimeCredential">> {
        return await this.#operate(projectId).findRuntimeCredential(tokenHash, uncancelled);
    }

    async recordAudit(projectId: string, audit: PlatformAuditRecord): Promise<void> {
        await this.#operate(projectId).recordAudit(audit, uncancelled);
    }

    async listAuditEvents(projectId: string, limit: number): Promise<readonly ProjectAuditRow[]> {
        return await this.#operate(projectId).listAuditEvents(limit, uncancelled);
    }
}
