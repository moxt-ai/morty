import type { ProjectLocationHint } from "@morty-build/client/protocol";
import { PairingDirectoryError, type RuntimePairingRequest } from "@morty-build/relay-core/contracts";
import { DatabaseError } from "@morty-build/relay-core/database";
import { logger } from "@morty-build/relay-core/logging";
import type { ComputerRelay } from "../durable-objects/computer-relay.ts";
import { decodeComputerPlacement } from "../entity/computer-id.ts";
import type { ComputerManagementStore, ComputerManagementStores } from "../infra/computer-management-store.ts";

const OPERATION_TIMEOUT_MILLISECONDS = 15_000;

type ProjectStub = DurableObjectStub<ComputerRelay>;

/**
 * A Project's store reached through its Account Durable Object. Every operation executes there as one unit;
 * cancelling or timing out here stops waiting for the result but cannot undo an operation already delivered.
 */
class ComputerDurableObjectStore implements ComputerManagementStore {
    readonly #namespace: DurableObjectNamespace<ComputerRelay>;
    readonly #computerId: string;
    readonly #locationHint: ProjectLocationHint;
    #stub: ProjectStub | null = null;

    constructor(
        namespace: DurableObjectNamespace<ComputerRelay>,
        computerId: string,
        locationHint: ProjectLocationHint,
    ) {
        this.#namespace = namespace;
        this.#computerId = computerId;
        this.#locationHint = locationHint;
    }

    private readonly call = async <Value>(
        operation: string,
        invoke: (stub: ProjectStub, computerId: string) => Promise<Value>,
        signal: AbortSignal,
    ): Promise<Value> => {
        signal.throwIfAborted();
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), OPERATION_TIMEOUT_MILLISECONDS);
        const deadline = AbortSignal.any([signal, timeout.signal]);
        let abort = (): void => {};
        try {
            this.#stub ??= this.#namespace.getByName(this.#computerId, { locationHint: this.#locationHint });
            const value = await Promise.race([
                invoke(this.#stub, this.#computerId),
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
                    durableObjectClass: "ComputerRelay",
                    durableObjectId: this.#namespace.idFromName(this.#computerId).toString(),
                    computerId: this.#computerId,
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

    readonly updateAgentCatalog: ComputerManagementStore["updateAgentCatalog"] = (
        computerId,
        tokenHash,
        agents,
        signal,
    ) => this.call("updateAgentCatalog", (stub) => stub.updateAgentCatalog(computerId, tokenHash, agents), signal);

    readonly readActiveGeneration: ComputerManagementStore["readActiveGeneration"] = (computerId, signal) =>
        this.call("readActiveGeneration", (stub) => stub.readActiveGeneration(computerId), signal);

    readonly readRuntime: ComputerManagementStore["readRuntime"] = (computerId, signal) =>
        this.call("readRuntime", (stub) => stub.readRuntime(computerId), signal);

    readonly listRuntimes: ComputerManagementStore["listRuntimes"] = (signal) =>
        this.call("listRuntimes", (stub, computerId) => stub.listRuntimes(computerId), signal);

    readonly requestRuntimePairing: ComputerManagementStore["requestRuntimePairing"] = (value, signal) =>
        this.call(
            "requestRuntimePairing",
            async (stub, computerId): Promise<RuntimePairingRequest> =>
                await stub.requestRuntimePairing(computerId, value),
            signal,
        );

    readonly readRuntimePairing: ComputerManagementStore["readRuntimePairing"] = (computerId, signal) =>
        this.call("readRuntimePairing", (stub) => stub.readRuntimePairing(computerId), signal);

    readonly readPairingCode: ComputerManagementStore["readPairingCode"] = (codeHash, signal) =>
        this.call("readPairingCode", (stub, computerId) => stub.readPairingCode(computerId, codeHash), signal);

    readonly claimPairing: ComputerManagementStore["claimPairing"] = (value, signal) =>
        this.call("claimPairing", (stub, computerId) => stub.claimPairing(computerId, value), signal);

    readonly revokeRuntime: ComputerManagementStore["revokeRuntime"] = (value, signal) =>
        this.call("revokeRuntime", (stub, computerId) => stub.revokeRuntime(computerId, value), signal);

    readonly findCredential: ComputerManagementStore["findCredential"] = (credential, signal) =>
        this.call("findCredential", (stub, computerId) => stub.findCredential(computerId, credential), signal);

    readonly rotateRuntimeCredential: ComputerManagementStore["rotateRuntimeCredential"] = (
        presentedHash,
        successorHash,
        signal,
    ) =>
        this.call<Awaited<ReturnType<ComputerManagementStore["rotateRuntimeCredential"]>>>(
            "rotateRuntimeCredential",
            (stub, computerId) => stub.rotateRuntimeCredential(computerId, presentedHash, successorHash),
            signal,
        );

    readonly holdsAccess: ComputerManagementStore["holdsAccess"] = (holder, signal) =>
        this.call("holdsAccess", (stub, computerId) => stub.holdsAccess(computerId, holder), signal);

    readonly recordAudit: ComputerManagementStore["recordAudit"] = (audit, signal) =>
        this.call("recordAudit", (stub, computerId) => stub.recordAudit(computerId, audit), signal);

    readonly listAuditEvents: ComputerManagementStore["listAuditEvents"] = (limit, signal) =>
        this.call("listAuditEvents", (stub, computerId) => stub.listAuditEvents(computerId, limit), signal);
}

/**
 * Locates Project stores. Inside a Account Durable Object its own Project resolves to the local store; every other
 * Project resolves to its own Durable Object.
 */
export class ComputerDurableObjectStores implements ComputerManagementStores {
    readonly #namespace: DurableObjectNamespace<ComputerRelay>;
    readonly #local: { readonly computerId: string; readonly store: ComputerManagementStore } | null;
    readonly #remote = new Map<string, ComputerManagementStore>();

    constructor(
        namespace: DurableObjectNamespace<ComputerRelay>,
        local: { readonly computerId: string; readonly store: ComputerManagementStore } | null = null,
    ) {
        this.#namespace = namespace;
        this.#local = local;
    }

    readonly forProject: ComputerManagementStores["forProject"] = (computerId) => {
        if (this.#local?.computerId === computerId) {
            return this.#local.store;
        }
        const existing = this.#remote.get(computerId);
        if (existing !== undefined) {
            return existing;
        }
        const placement = decodeComputerPlacement(computerId);
        if (placement === null) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        const store = new ComputerDurableObjectStore(this.#namespace, computerId, placement.locationHint);
        this.#remote.set(computerId, store);
        return store;
    };

    readonly resolve: ComputerManagementStores["resolve"] = (placement) => {
        if (!placement.hasShard) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        return this.forProject(placement.shard.d1ShardId);
    };
}
