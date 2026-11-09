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
import { decodeAccountDurableObjectPath } from "../entity/account-durable-object-path.ts";
import { decodeAccountPlacement } from "../entity/machine-account-id.ts";
import type { PlatformAuditRecord, ProjectAuditRow } from "../entity/platform-records.ts";
import { accountDurableObjectMigrations } from "../generated/project-do-migrations.ts";
import type { PlatformProjectStore } from "../infra/platform-project-store.ts";
import {
    type AccountPlatformRelayBindings,
    type ConfiguredPlatformRelayBindings,
    createPlatformWorker,
} from "../platform-worker.ts";
import { AccountObjectIdentityStorage } from "../storage/project-object-identity-storage.ts";
import { SqlitePlatformProjectStore } from "../storage/sqlite-platform-project-store.ts";

type Store = PlatformProjectStore;
type Result<Operation extends keyof Store> = Awaited<ReturnType<Store[Operation]>>;

// Operations run to completion once delivered; a caller that gives up only stops waiting for the result.
const uncancelled = new AbortController().signal;

/**
 * Owns one account's storage. Requests routed to the account run here against that storage, and every other
 * Worker or Durable Object reaches it only through the typed operations below, each executed here as one unit.
 */
export class AccountDO extends DurableObject<ConfiguredPlatformRelayBindings> {
    readonly #application = createPlatformWorker();
    readonly #database: DurableObjectDatabaseAdapter;
    readonly #identity: AccountObjectIdentityStorage;
    readonly #environment: ConfiguredPlatformRelayBindings;
    readonly #durableObjectId: string;
    #store: Store | null = null;

    constructor(state: DurableObjectState, environment: ConfiguredPlatformRelayBindings) {
        super(state, environment);
        this.#environment = environment;
        this.#durableObjectId = state.id.toString();
        try {
            applyDurableObjectMigrations(state.storage, accountDurableObjectMigrations);
            this.#identity = new AccountObjectIdentityStorage(state.storage);
            this.#database = new DurableObjectDatabaseAdapter(state.storage);
        } catch (error) {
            logger.error(
                {
                    event: "account_do_initialization_failed",
                    durableObjectClass: "AccountDO",
                    durableObjectId: this.#durableObjectId,
                    err: error,
                },
                "Account Durable Object initialization failed",
            );
            throw error;
        }
    }

    /** The store of the account this object holds; null when `accountId` names another account. */
    #accountStore(accountId: string): Store | null {
        if (!this.#identity.bind(accountId)) {
            return null;
        }
        this.#store ??= new SqlitePlatformProjectStore(accountId, this.#database);
        return this.#store;
    }

    #operate(accountId: string): Store {
        const store = decodeAccountPlacement(accountId) === null ? null : this.#accountStore(accountId);
        if (store === null) {
            throw new Error("The account is unavailable");
        }
        return store;
    }

    override async fetch(request: Request): Promise<Response> {
        const requestUrl = new URL(request.url);
        const accountPath = decodeAccountDurableObjectPath(requestUrl.pathname);
        try {
            const placement = accountPath === null ? null : decodeAccountPlacement(accountPath.accountId);
            if (accountPath === null || placement === null) {
                return Response.json(
                    { error: { code: "project_id_invalid", message: "The Project identifier is invalid" } },
                    { status: 400 },
                );
            }
            const accountId = accountPath.accountId;
            const store = this.#accountStore(accountId);
            if (store === null) {
                return Response.json(
                    { error: { code: "project_id_mismatch", message: "The account is unavailable" } },
                    { status: 421 },
                );
            }
            requestUrl.pathname = accountPath.requestPathname;
            const routedRequest = new Request(requestUrl, request);
            const environment: ConfiguredPlatformRelayBindings & AccountPlatformRelayBindings = {
                ...this.#environment,
                MORTY_ACCOUNT_STORE: store,
                MORTY_ACCOUNT_ID: accountId,
            };
            return await this.#application.fetch(routedRequest, environment);
        } catch (error) {
            request.signal.throwIfAborted();
            logger.error(
                {
                    event: "project_do_request_failed",
                    durableObjectClass: "AccountDO",
                    durableObjectId: this.#durableObjectId,
                    accountId: accountPath?.accountId ?? null,
                    method: request.method,
                    path: accountPath?.requestPathname ?? requestUrl.pathname,
                    cfRay: request.headers.get("cf-ray")?.slice(0, 128) ?? null,
                    err: error,
                },
                "Account Durable Object request failed",
            );
            throw error;
        }
    }

    async authenticateHost(
        accountId: string,
        channelId: string,
        tokenHash: string,
        now: number,
    ): Promise<Result<"authenticateHost">> {
        return await this.#operate(accountId).authenticateHost(channelId, tokenHash, now, uncancelled);
    }

    async isHostCredentialActive(
        accountId: string,
        identity: Parameters<Store["isHostCredentialActive"]>[0],
    ): Promise<boolean> {
        return await this.#operate(accountId).isHostCredentialActive(identity, uncancelled);
    }

    async listLinkedDevices(accountId: string, channelId: string): Promise<Result<"listLinkedDevices">> {
        return await this.#operate(accountId).listLinkedDevices(channelId, uncancelled);
    }

    async revokeLinkedDevice(
        accountId: string,
        channelId: string,
        credentialId: string,
        now: number,
    ): Promise<boolean> {
        return await this.#operate(accountId).revokeLinkedDevice(channelId, credentialId, now, uncancelled);
    }

    async createAccessGrant(accountId: string, value: CreateAccessGrant): Promise<boolean> {
        return await this.#operate(accountId).createAccessGrant(value, uncancelled);
    }

    async redeemAccessGrant(accountId: string, value: RedeemAccessGrant): Promise<AccessGrantRedemption> {
        return await this.#operate(accountId).redeemAccessGrant(value, uncancelled);
    }

    async createBrowserCredential(accountId: string, value: CreateBrowserCredential): Promise<boolean> {
        return await this.#operate(accountId).createBrowserCredential(value, uncancelled);
    }

    async revokeBrowserCredential(accountId: string, credentialId: string, now: number): Promise<boolean> {
        return await this.#operate(accountId).revokeBrowserCredential(credentialId, now, uncancelled);
    }

    async updateAgentCatalog(
        accountId: string,
        channelId: string,
        tokenHash: string,
        agents: string,
    ): Promise<boolean> {
        return await this.#operate(accountId).updateAgentCatalog(channelId, tokenHash, agents, uncancelled);
    }

    async isRuntimeActive(accountId: string, runtimeId: string): Promise<boolean> {
        return await this.#operate(accountId).isRuntimeActive(runtimeId, uncancelled);
    }

    async readRuntime(accountId: string, runtimeId: string): Promise<Result<"readRuntime">> {
        return await this.#operate(accountId).readRuntime(runtimeId, uncancelled);
    }

    async listRuntimes(accountId: string): Promise<Result<"listRuntimes">> {
        return await this.#operate(accountId).listRuntimes(uncancelled);
    }

    async readChannel(accountId: string, channelId: string): Promise<Result<"readChannel">> {
        return await this.#operate(accountId).readChannel(channelId, uncancelled);
    }

    async requestRuntimePairing(accountId: string, value: RequestRuntimePairing): Promise<RuntimePairingRequest> {
        return await this.#operate(accountId).requestRuntimePairing(value, uncancelled);
    }

    async readRuntimePairing(accountId: string, pairingId: string): Promise<Result<"readRuntimePairing">> {
        return await this.#operate(accountId).readRuntimePairing(pairingId, uncancelled);
    }

    async readPairingCode(accountId: string, codeHash: string): Promise<Result<"readPairingCode">> {
        return await this.#operate(accountId).readPairingCode(codeHash, uncancelled);
    }

    async claimPairing(accountId: string, value: ClaimPairing): Promise<boolean> {
        return await this.#operate(accountId).claimPairing(value, uncancelled);
    }

    async revokeRuntime(accountId: string, value: RevokeRuntime): Promise<Result<"revokeRuntime">> {
        return await this.#operate(accountId).revokeRuntime(value, uncancelled);
    }

    async findCredential(
        accountId: string,
        credential: Parameters<Store["findCredential"]>[0],
    ): Promise<Result<"findCredential">> {
        return await this.#operate(accountId).findCredential(credential, uncancelled);
    }

    async rotateRuntimeCredential(
        accountId: string,
        presentedHash: string,
        successorHash: string,
    ): Promise<Result<"rotateRuntimeCredential">> {
        return await this.#operate(accountId).rotateRuntimeCredential(presentedHash, successorHash, uncancelled);
    }

    async recordAudit(accountId: string, audit: PlatformAuditRecord): Promise<void> {
        await this.#operate(accountId).recordAudit(audit, uncancelled);
    }

    async listAuditEvents(accountId: string, limit: number): Promise<readonly ProjectAuditRow[]> {
        return await this.#operate(accountId).listAuditEvents(limit, uncancelled);
    }
}
