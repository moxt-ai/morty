import { PROJECT_HOST_PERMISSIONS, ProjectPermission } from "../entity/authentication/project-authentication.ts";
import { ComputerScope } from "../entity/do/session.ts";
import type { ProjectCredentialAuthority } from "../gateway/project-access-authorizer.ts";
import { createRuntimeRoutes } from "../http/do/runtime-routes.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { ProjectStoreResolver } from "../infra/project-store.ts";
import { ChannelActor } from "../service/channel/channel-actor.ts";
import { ChannelCredentialService } from "../service/channel/channel-credential-service.ts";
import { LocalRuntimeRequests } from "../service/channel/local-runtime-requests.ts";
import { NativeSessionForks } from "../service/channel/native-session-forks.ts";
import { RuntimeConnectionService } from "../service/channel/runtime-connection-service.ts";
import { type RuntimeCredentials, type RuntimePeers, RuntimeService } from "../service/channel/runtime-service.ts";
import { RuntimeConnectionStorage } from "../storage/runtime-connection-storage.ts";

function createRuntimeRelayDependencies(cx: {
    readonly database: DoSqlDatabase;
    readonly storages: {
        readonly projectStores: ProjectStoreResolver;
        readonly projectDirectory: ProjectStorageDirectory;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
        readonly projectCredentials: ProjectCredentialAuthority;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}) {
    /** Null when the Project is no longer served: none of its credentials remain active. */
    const credentialService = async (scope: ComputerScope, signal: AbortSignal) => {
        const project = await cx.storages.projectDirectory.resolve(scope.computerId, signal);
        signal.throwIfAborted();
        if (project === null) {
            return null;
        }
        if (project.computerId !== scope.computerId) {
            throw new Error("The Project placement is invalid");
        }
        return new ChannelCredentialService(cx.storages.projectStores.resolve(project.computerId));
    };
    const credentials: RuntimeCredentials = {
        authorizeHostMessage: async (identity, permission, signal) => {
            const service = await credentialService(new ComputerScope(identity.computerId), signal);
            if (service === null) {
                return "revoked";
            }
            if (
                (await service.activeGeneration(identity, signal)) === null ||
                !(await cx.gateways.projectCredentials.grants(identity.computerId, PROJECT_HOST_PERMISSIONS, signal))
            ) {
                return "revoked";
            }
            if (permission === null || PROJECT_HOST_PERMISSIONS.includes(permission)) {
                return "granted";
            }
            return (await cx.gateways.projectCredentials.grants(identity.computerId, [permission], signal))
                ? "granted"
                : "denied";
        },
        authorizeViewer: async (identity, signal) => {
            return (await cx.gateways.projectCredentials.grantsSessionCredential(
                identity.computerId,
                identity.credential.grant,
                [ProjectPermission.SessionRead],
                signal,
            ))
                ? "granted"
                : "revoked";
        },
        activeGeneration: async (identity, signal) => {
            const service = await credentialService(new ComputerScope(identity.computerId), signal);
            return service === null ? null : await service.activeGeneration(identity, signal);
        },
    };
    const services = {
        credentials,
        connections: new RuntimeConnectionService(new RuntimeConnectionStorage(cx.database)),
        channel: (scope: ComputerScope) =>
            new ChannelActor({
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
        readonly projectStores: ProjectStoreResolver;
        readonly projectDirectory: ProjectStorageDirectory;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
        readonly projectCredentials: ProjectCredentialAuthority;
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
            projectCredentials: cx.gateways.projectCredentials,
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
