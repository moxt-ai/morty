import { COMPUTER_HOST_PERMISSIONS, ComputerPermission } from "../entity/authentication/computer-authentication.ts";
import type { ComputerCredentialAuthority } from "../entity/authentication/computer-authorization.ts";
import { ComputerScope } from "../entity/do/session.ts";
import { createRuntimeRoutes } from "../http/do/runtime-routes.ts";
import type { ComputerStorageDirectory } from "../infra/computer-storage-directory.ts";
import type { ComputerStoreResolver } from "../infra/computer-store.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { ComputerConnectionService } from "../service/computer/computer-connection-service.ts";
import { ComputerConnections } from "../service/computer/computer-connections.ts";
import { LocalRuntimeRequests } from "../service/computer/local-runtime-requests.ts";
import { NativeSessionForks } from "../service/computer/native-session-forks.ts";
import { type RuntimeCredentials, type RuntimePeers, RuntimeService } from "../service/computer/runtime-service.ts";
import { ComputerConnectionStorage } from "../storage/computer-connection-storage.ts";

function createRuntimeRelayDependencies(cx: {
    readonly database: DoSqlDatabase;
    readonly storages: {
        readonly computerStores: ComputerStoreResolver;
        readonly computerDirectory: ComputerStorageDirectory;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
        readonly computerCredentials: ComputerCredentialAuthority;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}) {
    /** Null when the Computer is no longer served: none of its credentials remain active. */
    const computerStore = async (scope: ComputerScope, signal: AbortSignal) => {
        const computer = await cx.storages.computerDirectory.resolve(scope.computerId, signal);
        signal.throwIfAborted();
        if (computer === null) {
            return null;
        }
        if (computer.computerId !== scope.computerId) {
            throw new Error("The Computer placement is invalid");
        }
        return cx.storages.computerStores.resolve(computer.computerId);
    };
    const credentials: RuntimeCredentials = {
        authorizeHostMessage: async (identity, permission, signal) => {
            const store = await computerStore(new ComputerScope(identity.computerId), signal);
            if (store === null) {
                return "revoked";
            }
            if (
                (await store.readActiveGeneration(identity.computerId, signal)) === null ||
                !(await cx.gateways.computerCredentials.grants(identity.computerId, COMPUTER_HOST_PERMISSIONS, signal))
            ) {
                return "revoked";
            }
            if (permission === null || COMPUTER_HOST_PERMISSIONS.includes(permission)) {
                return "granted";
            }
            return (await cx.gateways.computerCredentials.grants(identity.computerId, [permission], signal))
                ? "granted"
                : "denied";
        },
        authorizeViewer: async (identity, signal) => {
            return (await cx.gateways.computerCredentials.grantsSessionCredential(
                identity.computerId,
                identity.credential.grant,
                [ComputerPermission.SessionRead],
                signal,
            ))
                ? "granted"
                : "revoked";
        },
        activeGeneration: async (identity, signal) => {
            const store = await computerStore(new ComputerScope(identity.computerId), signal);
            return store === null ? null : await store.readActiveGeneration(identity.computerId, signal);
        },
    };
    const services = {
        credentials,
        connections: new ComputerConnectionService(new ComputerConnectionStorage(cx.database)),
        computerConnections: (scope: ComputerScope) =>
            new ComputerConnections({
                config: { computerId: scope.computerId },
                gateways: {
                    peers: cx.gateways.peers,
                },
            }),
    };
    return {
        services: {
            credentials,
            connections: services.connections,
            runtime: new RuntimeService({
                services,
                gateways: cx.gateways,
                utilities: cx.utilities,
            }),
        },
        gateways: cx.gateways,
        storages: cx.storages,
        utilities: cx.utilities,
    };
}

export type DurableObjectContext = ReturnType<typeof createDurableObjectDependencies>;

export function createDurableObjectDependencies(cx: {
    readonly doDatabase: DoSqlDatabase;
    readonly storages: {
        readonly computerStores: ComputerStoreResolver;
        readonly computerDirectory: ComputerStorageDirectory;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
        readonly computerCredentials: ComputerCredentialAuthority;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}) {
    const requests = new LocalRuntimeRequests();
    const source = cx.gateways.peers;
    const peers: RuntimePeers = {
        accept: source.accept,
        sockets: source.sockets,
        daemonConnections: source.daemonConnections,
        daemons: source.daemons,
        hosts: source.hosts,
        nativeRequests: source.nativeRequests,
        viewers: source.viewers,
        historyRecipients: () => [...source.historyRecipients(), ...requests.routes().map(({ socket }) => socket)],
        operations: () => [...source.operations(), ...requests.routes()],
    };
    const runtime = createRuntimeRelayDependencies({
        database: cx.doDatabase,
        gateways: {
            peers,
            computerCredentials: cx.gateways.computerCredentials,
        },
        storages: cx.storages,
        utilities: cx.utilities,
    });
    return {
        doDatabase: cx.doDatabase,
        gateways: { ...cx.gateways, peers, requests },
        storages: cx.storages,
        utilities: cx.utilities,
        services: {
            ...runtime.services,
            nativeForks: new NativeSessionForks(cx.utilities.waitUntil),
        },
        applications: {
            runtime: createRuntimeRoutes(runtime.services.runtime),
        },
    };
}
