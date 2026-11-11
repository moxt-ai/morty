import type { ComputerScope } from "../../../contracts/relay/session.ts";
import type { BackendProjectAccess } from "../../../directory/service/backend-project-access.ts";
import type { ComputerManagementStorageDirectory } from "../../../directory/service/computer-management-storage-directory.ts";
import type { DurableObjectDatabase } from "../../infra/durable-object-database.ts";
import type { ComputerRelayStore } from "../management/storage/computer-relay-store.ts";
import { createComputerRoutes } from "./http/computer-routes.ts";
import { ComputerCredentialService } from "./service/computer-credential-service.ts";
import { ComputerRelayActor } from "./service/computer-relay-actor.ts";
import { type ComputerPeers, ComputerService } from "./service/computer-service.ts";
import { DaemonConnectionService } from "./service/daemon-connection-service.ts";
import { LocalComputerRequests } from "./service/local-computer-requests.ts";
import { NativeSessionForks } from "./service/native-session-forks.ts";
import { ComputerConnectionStorage } from "./storage/computer-connection-storage.ts";

export type RuntimeContext = ReturnType<typeof createRuntimeContext>;

export function createRuntimeContext(cx: {
    readonly doDatabase: DurableObjectDatabase;
    readonly storages: {
        readonly projectStore: Pick<ComputerRelayStore, "readActiveGeneration">;
    };
    readonly services: {
        readonly projects: Pick<ComputerManagementStorageDirectory, "resolve">;
        readonly projectAccess: Pick<BackendProjectAccess, "grants" | "grantsSessionCredential">;
    };
    readonly gateways: {
        readonly peers: ComputerPeers;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}) {
    const requests = new LocalComputerRequests();
    const source = cx.gateways.peers;
    const peers: ComputerPeers = {
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
    const credentials = new ComputerCredentialService(
        cx.storages.projectStore,
        cx.services.projects,
        cx.services.projectAccess,
    );
    const connections = new DaemonConnectionService(new ComputerConnectionStorage(cx.doDatabase));
    const runtime = new ComputerService({
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
            runtime: createComputerRoutes({ services: { runtime } }),
        },
    };
}
