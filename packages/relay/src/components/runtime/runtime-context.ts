import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import type { BackendProjectAccess } from "../management/service/backend-project-access.ts";
import type { ComputerManagementStorageDirectory } from "../management/service/computer-management-storage-directory.ts";
import type { ComputerRelayStoreResolver } from "../management/storage/computer-relay-store.ts";
import type { ComputerScope } from "./entity/session.ts";
import { createRuntimeRoutes } from "./http/runtime-routes.ts";
import { ComputerRelayActor } from "./service/computer-relay-actor.ts";
import { DaemonConnectionService } from "./service/daemon-connection-service.ts";
import { LocalRuntimeRequests } from "./service/local-runtime-requests.ts";
import { NativeSessionForks } from "./service/native-session-forks.ts";
import { RuntimeCredentialService } from "./service/runtime-credential-service.ts";
import { type RuntimePeers, RuntimeService } from "./service/runtime-service.ts";
import { ComputerConnectionStorage } from "./storage/computer-connection-storage.ts";

export type RuntimeContext = ReturnType<typeof createRuntimeContext>;

export function createRuntimeContext(cx: {
    readonly doDatabase: DoSqlDatabase;
    readonly storages: {
        readonly projectStores: ComputerRelayStoreResolver;
    };
    readonly services: {
        readonly projects: Pick<ComputerManagementStorageDirectory, "resolve">;
        readonly projectAccess: Pick<BackendProjectAccess, "grants" | "grantsSessionCredential">;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
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
    const credentials = new RuntimeCredentialService(
        cx.storages.projectStores,
        cx.services.projects,
        cx.services.projectAccess,
    );
    const connections = new DaemonConnectionService(new ComputerConnectionStorage(cx.doDatabase));
    const runtime = new RuntimeService({
        services: {
            credentials,
            connections,
            relay: (scope: ComputerScope) =>
                new ComputerRelayActor({ config: { computerId: scope.computerId }, gateways: { peers } }),
        },
        gateways: { peers },
        utilities: cx.utilities,
    });
    return {
        doDatabase: cx.doDatabase,
        gateways: { ...cx.gateways, peers, requests },
        storages: cx.storages,
        utilities: cx.utilities,
        services: {
            ...cx.services,
            credentials,
            connections,
            runtime,
            nativeForks: new NativeSessionForks(cx.utilities.waitUntil),
        },
        applications: {
            runtime: createRuntimeRoutes(runtime),
        },
    };
}
