import type { ChannelGateway } from "../gateway/channel-gateway.ts";
import type { ProjectAccessAuthorizer } from "../gateway/project-access-authorizer.ts";
import type { MachineAccountDirectory } from "../infra/machine-account-directory.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { ProjectStore, ProjectStoreResolver } from "../infra/project-store.ts";
import type { LocalSessionOperations } from "../service/channel/local-session-operations.ts";
import { createRelayDependencies } from "./create-relay-dependencies.ts";

export interface WorkerComputerGateways {
    readonly channel: ChannelGateway;
    readonly computerOperations?: LocalSessionOperations;
}

export function createWorkerContext(options: {
    readonly applications: MachineAccountDirectory;
    readonly authorization: ProjectAccessAuthorizer;
    readonly stores: ProjectStoreResolver;
    readonly identityStores: readonly ProjectStore[];
    readonly projects: ProjectStorageDirectory;
    readonly apiPrefix: string;
    readonly gateways: WorkerComputerGateways;
}) {
    return createRelayDependencies({
        authentication: { projects: options.authorization },
        config: { apiPrefix: options.apiPrefix },
        stores: options.stores,
        identityStores: options.identityStores,
        machineAccounts: options.applications,
        projects: options.projects,
        logger: console,
        gateways: {
            channelGateway: options.gateways.channel,
            ...(options.gateways.computerOperations === undefined
                ? {}
                : { computerOperations: options.gateways.computerOperations }),
            nowEpochMilliseconds: () => Date.now(),
        },
    });
}
