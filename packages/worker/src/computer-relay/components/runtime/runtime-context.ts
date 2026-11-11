import type { ComputerManagementService } from "../../../directory/service/computer-management-service.ts";
import type { ComputerAccessService } from "../../../directory/service/computer-access-service.ts";
import type { DurableObjectDatabase } from "../../infra/durable-object-database.ts";
import type { ComputerRelayStore } from "../management/storage/computer-relay-store.ts";
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
        readonly computerAccounts: Pick<ComputerManagementService, "isActive">;
        readonly projectAccess: Pick<ComputerAccessService, "grantsSessionCredential">;
    };
    readonly gateways: {
        readonly peers: Omit<ComputerPeers, "operations">;
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
        viewers: source.viewers,
        operations: requests.routes,
    };
    const credentials = new ComputerCredentialService(cx.storages.projectStore, cx.services.computerAccounts, cx.services.projectAccess);
    const connections = new DaemonConnectionService(new ComputerConnectionStorage(cx.doDatabase));
    const runtime = new ComputerService({
        services: {
            credentials,
            connections,
            relay: (computerId: string) => new ComputerRelayActor({ config: { computerId }, gateways: { peers } }),
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
    };
}
