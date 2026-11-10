import type { ProjectLocationHint } from "@morty-build/client/protocol";
import { PairingDirectoryError, type RuntimePairingRequest } from "@morty-build/relay-core/contracts";
import { DatabaseError } from "@morty-build/relay-core/database";
import { logger } from "@morty-build/relay-core/logging";
import type { ComputerRelay } from "../durable-objects/computer-relay.ts";
import { decodeComputerPlacement } from "../entity/computer-id.ts";
import type { PlatformProjectStore, PlatformProjectStores } from "../infra/platform-project-store.ts";

const OPERATION_TIMEOUT_MILLISECONDS = 15_000;

type ProjectStub = DurableObjectStub<ComputerRelay>;

/**
 * A Project's store reached through its Account Durable Object. Every operation executes there as one unit;
 * cancelling or timing out here stops waiting for the result but cannot undo an operation already delivered.
 */
class ComputerDurableObjectStore implements PlatformProjectStore {
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

    readonly updateAgentCatalog: PlatformProjectStore["updateAgentCatalog"] = (computerId, tokenHash, agents, signal) =>
        this.call("updateAgentCatalog", (stub) => stub.updateAgentCatalog(computerId, tokenHash, agents), signal);

    readonly isRuntimeActive: PlatformProjectStore["isRuntimeActive"] = (computerId, signal) =>
        this.call("isRuntimeActive", (stub) => stub.isRuntimeActive(computerId), signal);

    readonly readRuntime: PlatformProjectStore["readRuntime"] = (computerId, signal) =>
        this.call("readRuntime", (stub) => stub.readRuntime(computerId), signal);

    readonly listRuntimes: PlatformProjectStore["listRuntimes"] = (signal) =>
        this.call("listRuntimes", (stub, computerId) => stub.listRuntimes(computerId), signal);

    readonly requestRuntimePairing: PlatformProjectStore["requestRuntimePairing"] = (value, signal) =>
        this.call(
            "requestRuntimePairing",
            async (stub, computerId): Promise<RuntimePairingRequest> =>
                await stub.requestRuntimePairing(computerId, value),
            signal,
        );

    readonly readRuntimePairing: PlatformProjectStore["readRuntimePairing"] = (computerId, signal) =>
        this.call("readRuntimePairing", (stub) => stub.readRuntimePairing(computerId), signal);

    readonly readPairingCode: PlatformProjectStore["readPairingCode"] = (codeHash, signal) =>
        this.call("readPairingCode", (stub, computerId) => stub.readPairingCode(computerId, codeHash), signal);

    readonly claimPairing: PlatformProjectStore["claimPairing"] = (value, signal) =>
        this.call("claimPairing", (stub, computerId) => stub.claimPairing(computerId, value), signal);

    readonly revokeRuntime: PlatformProjectStore["revokeRuntime"] = (value, signal) =>
        this.call("revokeRuntime", (stub, computerId) => stub.revokeRuntime(computerId, value), signal);

    readonly findCredential: PlatformProjectStore["findCredential"] = (credential, signal) =>
        this.call("findCredential", (stub, computerId) => stub.findCredential(computerId, credential), signal);

    readonly rotateRuntimeCredential: PlatformProjectStore["rotateRuntimeCredential"] = (
        presentedHash,
        successorHash,
        signal,
    ) =>
        this.call<Awaited<ReturnType<PlatformProjectStore["rotateRuntimeCredential"]>>>(
            "rotateRuntimeCredential",
            (stub, computerId) => stub.rotateRuntimeCredential(computerId, presentedHash, successorHash),
            signal,
        );

    readonly revokeSessionAccess: PlatformProjectStore["revokeSessionAccess"] = (revokedAt, signal) =>
        this.call("revokeSessionAccess", (stub, computerId) => stub.revokeSessionAccess(computerId, revokedAt), signal);

    readonly readSessionAccessRevocation: PlatformProjectStore["readSessionAccessRevocation"] = (signal) =>
        this.call(
            "readSessionAccessRevocation",
            (stub, computerId) => stub.readSessionAccessRevocation(computerId),
            signal,
        );

    readonly recordAudit: PlatformProjectStore["recordAudit"] = (audit, signal) =>
        this.call("recordAudit", (stub, computerId) => stub.recordAudit(computerId, audit), signal);

    readonly listAuditEvents: PlatformProjectStore["listAuditEvents"] = (limit, signal) =>
        this.call("listAuditEvents", (stub, computerId) => stub.listAuditEvents(computerId, limit), signal);
}

/**
 * Locates Project stores. Inside a Account Durable Object its own Project resolves to the local store; every other
 * Project resolves to its own Durable Object.
 */
export class ComputerDurableObjectStores implements PlatformProjectStores {
    readonly #namespace: DurableObjectNamespace<ComputerRelay>;
    readonly #local: { readonly computerId: string; readonly store: PlatformProjectStore } | null;
    readonly #remote = new Map<string, PlatformProjectStore>();

    constructor(
        namespace: DurableObjectNamespace<ComputerRelay>,
        local: { readonly computerId: string; readonly store: PlatformProjectStore } | null = null,
    ) {
        this.#namespace = namespace;
        this.#local = local;
    }

    readonly forProject: PlatformProjectStores["forProject"] = (computerId) => {
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

    readonly resolve: PlatformProjectStores["resolve"] = (placement) => {
        if (!placement.hasShard) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        return this.forProject(placement.shard.d1ShardId);
    };
}
