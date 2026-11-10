import type { ProjectLocationHint } from "@morty-build/client/protocol";
import { PairingDirectoryError, type RuntimePairingRequest } from "@morty-build/relay-core/contracts";
import { DatabaseError } from "@morty-build/relay-core/database";
import { logger } from "@morty-build/relay-core/logging";
import type { ComputerRelay } from "../durable-objects/computer-relay.ts";
import { decodeComputerPlacement } from "../entity/computer-id.ts";
import type { ComputerManagementStore, ComputerManagementStores } from "../infra/computer-management-store.ts";
import type { ComputerSessionAccess, ComputerSessionAccessDirectory } from "../infra/computer-session-access.ts";

const OPERATION_TIMEOUT_MILLISECONDS = 15_000;

type ProjectStub = DurableObjectStub<ComputerRelay>;

/**
 * Calls a computer's ComputerRelay. Every operation executes there as one unit; cancelling or timing out here stops
 * waiting for the result but cannot undo an operation already delivered.
 */
abstract class ComputerDurableObjectCalls {
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

    protected readonly call = async <Value>(
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
}

/** A Project's store reached through its Account Durable Object. */
class ComputerDurableObjectStore extends ComputerDurableObjectCalls implements ComputerManagementStore {
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

    readonly recordAudit: ComputerManagementStore["recordAudit"] = (audit, signal) =>
        this.call("recordAudit", (stub, computerId) => stub.recordAudit(computerId, audit), signal);

    readonly listAuditEvents: ComputerManagementStore["listAuditEvents"] = (limit, signal) =>
        this.call("listAuditEvents", (stub, computerId) => stub.listAuditEvents(computerId, limit), signal);
}

/** A computer's Session access reached through its ComputerRelay, which owns both of its halves. */
class ComputerDurableObjectSessionAccess extends ComputerDurableObjectCalls implements ComputerSessionAccess {
    readonly currentGeneration: ComputerSessionAccess["currentGeneration"] = (holder, signal) =>
        this.call(
            "currentSessionGeneration",
            (stub, computerId) => stub.currentSessionGeneration(computerId, holder),
            signal,
        );
}

/**
 * Locates one kind of computer service. Inside a ComputerRelay its own computer resolves to the local service; every
 * other computer resolves to its own ComputerRelay.
 */
class ComputerDurableObjectLocator<Service> {
    readonly #local: { readonly computerId: string; readonly service: Service } | null;
    readonly #remote = new Map<string, Service>();
    readonly #connect: (computerId: string, locationHint: ProjectLocationHint) => Service;

    constructor(
        local: { readonly computerId: string; readonly service: Service } | null,
        connect: (computerId: string, locationHint: ProjectLocationHint) => Service,
    ) {
        this.#local = local;
        this.#connect = connect;
    }

    readonly locate = (computerId: string): Service => {
        if (this.#local?.computerId === computerId) {
            return this.#local.service;
        }
        const existing = this.#remote.get(computerId);
        if (existing !== undefined) {
            return existing;
        }
        const placement = decodeComputerPlacement(computerId);
        if (placement === null) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        const service = this.#connect(computerId, placement.locationHint);
        this.#remote.set(computerId, service);
        return service;
    };
}

/** Locates Project stores. */
export class ComputerDurableObjectStores implements ComputerManagementStores {
    readonly #stores: ComputerDurableObjectLocator<ComputerManagementStore>;

    constructor(
        namespace: DurableObjectNamespace<ComputerRelay>,
        local: { readonly computerId: string; readonly store: ComputerManagementStore } | null = null,
    ) {
        this.#stores = new ComputerDurableObjectLocator(
            local === null ? null : { computerId: local.computerId, service: local.store },
            (computerId, locationHint) => new ComputerDurableObjectStore(namespace, computerId, locationHint),
        );
    }

    readonly forProject: ComputerManagementStores["forProject"] = (computerId) => this.#stores.locate(computerId);

    readonly resolve: ComputerManagementStores["resolve"] = (placement) => {
        if (!placement.hasShard) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        return this.forProject(placement.shard.d1ShardId);
    };
}

/** Locates each computer's Session access. */
export class ComputerDurableObjectSessionAccessDirectory implements ComputerSessionAccessDirectory {
    readonly #access: ComputerDurableObjectLocator<ComputerSessionAccess>;

    constructor(
        namespace: DurableObjectNamespace<ComputerRelay>,
        local: { readonly computerId: string; readonly access: ComputerSessionAccess } | null = null,
    ) {
        this.#access = new ComputerDurableObjectLocator(
            local === null ? null : { computerId: local.computerId, service: local.access },
            (computerId, locationHint) => new ComputerDurableObjectSessionAccess(namespace, computerId, locationHint),
        );
    }

    readonly forComputer: ComputerSessionAccessDirectory["forComputer"] = (computerId) =>
        this.#access.locate(computerId);
}
