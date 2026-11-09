import type { ProjectLocationHint } from "@morty-build/client/protocol";
import {
    type AccessGrantRedemption,
    PairingDirectoryError,
    type RuntimePairingRequest,
} from "@morty-build/relay-core/contracts";
import { DatabaseError } from "@morty-build/relay-core/database";
import { logger } from "@morty-build/relay-core/logging";
import type { AccountDO } from "../durable-objects/account-do.ts";
import { decodeAccountPlacement } from "../entity/machine-account-id.ts";
import type { PlatformProjectStore, PlatformProjectStores } from "../infra/platform-project-store.ts";

const OPERATION_TIMEOUT_MILLISECONDS = 15_000;

type ProjectStub = DurableObjectStub<AccountDO>;

/**
 * A Project's store reached through its Account Durable Object. Every operation executes there as one unit;
 * cancelling or timing out here stops waiting for the result but cannot undo an operation already delivered.
 */
class AccountDurableObjectStore implements PlatformProjectStore {
    readonly #namespace: DurableObjectNamespace<AccountDO>;
    readonly #accountId: string;
    readonly #locationHint: ProjectLocationHint;
    #stub: ProjectStub | null = null;

    constructor(namespace: DurableObjectNamespace<AccountDO>, accountId: string, locationHint: ProjectLocationHint) {
        this.#namespace = namespace;
        this.#accountId = accountId;
        this.#locationHint = locationHint;
    }

    private readonly call = async <Value>(
        operation: string,
        invoke: (stub: ProjectStub, accountId: string) => Promise<Value>,
        signal: AbortSignal,
    ): Promise<Value> => {
        signal.throwIfAborted();
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), OPERATION_TIMEOUT_MILLISECONDS);
        const deadline = AbortSignal.any([signal, timeout.signal]);
        let abort = (): void => {};
        try {
            this.#stub ??= this.#namespace.getByName(this.#accountId, { locationHint: this.#locationHint });
            const value = await Promise.race([
                invoke(this.#stub, this.#accountId),
                new Promise<never>((_resolve, reject) => {
                    abort = () => reject(deadline.reason);
                    deadline.addEventListener("abort", abort, { once: true });
                    if (deadline.aborted) {
                        abort();
                    }
                }),
            ]);
            deadline.throwIfAborted();
            return value;
        } catch (cause) {
            signal.throwIfAborted();
            // A failed call may have broken the stub; the next operation connects again.
            this.#stub = null;
            logger.error(
                {
                    event: "project_database_request_failed",
                    durableObjectClass: "AccountDO",
                    durableObjectId: this.#namespace.idFromName(this.#accountId).toString(),
                    accountId: this.#accountId,
                    operation,
                    err: cause,
                },
                "Project database request failed",
            );
            throw new DatabaseError(
                timeout.signal.aborted ? "database_timeout" : "database_unavailable",
                "Project storage is unavailable",
                { cause },
            );
        } finally {
            clearTimeout(timer);
            deadline.removeEventListener("abort", abort);
        }
    };

    readonly authenticateHost: PlatformProjectStore["authenticateHost"] = (channelId, tokenHash, now, signal) =>
        this.call(
            "authenticateHost",
            (stub, accountId) => stub.authenticateHost(accountId, channelId, tokenHash, now),
            signal,
        );

    readonly isHostCredentialActive: PlatformProjectStore["isHostCredentialActive"] = (identity, signal) =>
        this.call(
            "isHostCredentialActive",
            (stub, accountId) => stub.isHostCredentialActive(accountId, identity),
            signal,
        );

    readonly listLinkedDevices: PlatformProjectStore["listLinkedDevices"] = (channelId, signal) =>
        this.call("listLinkedDevices", (stub, accountId) => stub.listLinkedDevices(accountId, channelId), signal);

    readonly revokeLinkedDevice: PlatformProjectStore["revokeLinkedDevice"] = (channelId, credentialId, now, signal) =>
        this.call(
            "revokeLinkedDevice",
            (stub, accountId) => stub.revokeLinkedDevice(accountId, channelId, credentialId, now),
            signal,
        );

    readonly createAccessGrant: PlatformProjectStore["createAccessGrant"] = (value, signal) =>
        this.call("createAccessGrant", (stub, accountId) => stub.createAccessGrant(accountId, value), signal);

    readonly redeemAccessGrant: PlatformProjectStore["redeemAccessGrant"] = (value, signal) =>
        this.call(
            "redeemAccessGrant",
            async (stub, accountId): Promise<AccessGrantRedemption> => await stub.redeemAccessGrant(accountId, value),
            signal,
        );

    readonly createBrowserCredential: PlatformProjectStore["createBrowserCredential"] = (value, signal) =>
        this.call(
            "createBrowserCredential",
            (stub, accountId) => stub.createBrowserCredential(accountId, value),
            signal,
        );

    readonly revokeBrowserCredential: PlatformProjectStore["revokeBrowserCredential"] = (credentialId, now, signal) =>
        this.call(
            "revokeBrowserCredential",
            (stub, accountId) => stub.revokeBrowserCredential(accountId, credentialId, now),
            signal,
        );

    readonly updateAgentCatalog: PlatformProjectStore["updateAgentCatalog"] = (channelId, tokenHash, agents, signal) =>
        this.call(
            "updateAgentCatalog",
            (stub, accountId) => stub.updateAgentCatalog(accountId, channelId, tokenHash, agents),
            signal,
        );

    readonly isRuntimeActive: PlatformProjectStore["isRuntimeActive"] = (runtimeId, signal) =>
        this.call("isRuntimeActive", (stub, accountId) => stub.isRuntimeActive(accountId, runtimeId), signal);

    readonly readRuntime: PlatformProjectStore["readRuntime"] = (runtimeId, signal) =>
        this.call("readRuntime", (stub, accountId) => stub.readRuntime(accountId, runtimeId), signal);

    readonly listRuntimes: PlatformProjectStore["listRuntimes"] = (signal) =>
        this.call("listRuntimes", (stub, accountId) => stub.listRuntimes(accountId), signal);

    readonly readChannel: PlatformProjectStore["readChannel"] = (channelId, signal) =>
        this.call("readChannel", (stub, accountId) => stub.readChannel(accountId, channelId), signal);

    readonly requestRuntimePairing: PlatformProjectStore["requestRuntimePairing"] = (value, signal) =>
        this.call(
            "requestRuntimePairing",
            async (stub, accountId): Promise<RuntimePairingRequest> =>
                await stub.requestRuntimePairing(accountId, value),
            signal,
        );

    readonly readRuntimePairing: PlatformProjectStore["readRuntimePairing"] = (pairingId, signal) =>
        this.call("readRuntimePairing", (stub, accountId) => stub.readRuntimePairing(accountId, pairingId), signal);

    readonly readPairingCode: PlatformProjectStore["readPairingCode"] = (codeHash, signal) =>
        this.call("readPairingCode", (stub, accountId) => stub.readPairingCode(accountId, codeHash), signal);

    readonly claimPairing: PlatformProjectStore["claimPairing"] = (value, signal) =>
        this.call("claimPairing", (stub, accountId) => stub.claimPairing(accountId, value), signal);

    readonly revokeRuntime: PlatformProjectStore["revokeRuntime"] = (value, signal) =>
        this.call("revokeRuntime", (stub, accountId) => stub.revokeRuntime(accountId, value), signal);

    readonly findCredential: PlatformProjectStore["findCredential"] = (credential, signal) =>
        this.call("findCredential", (stub, accountId) => stub.findCredential(accountId, credential), signal);

    readonly rotateRuntimeCredential: PlatformProjectStore["rotateRuntimeCredential"] = (
        presentedHash,
        successorHash,
        signal,
    ) =>
        this.call<Awaited<ReturnType<PlatformProjectStore["rotateRuntimeCredential"]>>>(
            "rotateRuntimeCredential",
            (stub, accountId) => stub.rotateRuntimeCredential(accountId, presentedHash, successorHash),
            signal,
        );

    readonly recordAudit: PlatformProjectStore["recordAudit"] = (audit, signal) =>
        this.call("recordAudit", (stub, accountId) => stub.recordAudit(accountId, audit), signal);

    readonly listAuditEvents: PlatformProjectStore["listAuditEvents"] = (limit, signal) =>
        this.call("listAuditEvents", (stub, accountId) => stub.listAuditEvents(accountId, limit), signal);
}

/**
 * Locates Project stores. Inside a Account Durable Object its own Project resolves to the local store; every other
 * Project resolves to its own Durable Object.
 */
export class AccountDurableObjectStores implements PlatformProjectStores {
    readonly #namespace: DurableObjectNamespace<AccountDO>;
    readonly #local: { readonly accountId: string; readonly store: PlatformProjectStore } | null;
    readonly #remote = new Map<string, PlatformProjectStore>();

    constructor(
        namespace: DurableObjectNamespace<AccountDO>,
        local: { readonly accountId: string; readonly store: PlatformProjectStore } | null = null,
    ) {
        this.#namespace = namespace;
        this.#local = local;
    }

    readonly forProject: PlatformProjectStores["forProject"] = (accountId) => {
        if (this.#local?.accountId === accountId) {
            return this.#local.store;
        }
        const existing = this.#remote.get(accountId);
        if (existing !== undefined) {
            return existing;
        }
        const placement = decodeAccountPlacement(accountId);
        if (placement === null) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        const store = new AccountDurableObjectStore(this.#namespace, accountId, placement.locationHint);
        this.#remote.set(accountId, store);
        return store;
    };

    readonly resolve: PlatformProjectStores["resolve"] = (placement) => {
        if (!placement.hasShard) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        return this.forProject(placement.shard.d1ShardId);
    };
}
