import type { ProjectAccessAuthorizer } from "../entity/authentication/project-authorization.ts";
import type { ComputerRelayGateway } from "../gateway/computer-relay-gateway.ts";
import type { ComputerRelayStore, ComputerRelayStoreResolver } from "../infra/computer-relay-store.ts";
import type { MachineAccountDirectory } from "../infra/machine-account-directory.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import { ComputerConnectionService } from "../service/computer-relay/computer-connection-service.ts";
import type { LocalSessionOperations } from "../service/computer-relay/local-session-operations.ts";
import { PairingDirectoryService } from "../service/pairing/pairing-directory-service.ts";
import { ComputerIdentityService } from "../service/pairing/pairing-identity-service.ts";
import { PairingService } from "../service/pairing/pairing-service.ts";

interface PairingInfrastructure {
    readonly authentication: { readonly projects: ProjectAccessAuthorizer };
    readonly machineAccounts: MachineAccountDirectory;
    readonly stores: ComputerRelayStoreResolver;
    readonly projects: ProjectStorageDirectory;
    /** The Project stores this execution searches to find the Project a credential belongs to. */
    readonly identityStores: readonly ComputerRelayStore[];
}

export interface RelayInfrastructure extends PairingInfrastructure {
    readonly authentication: { readonly projects: ProjectAccessAuthorizer };
    readonly gateways: {
        readonly computerRelayGateway: ComputerRelayGateway;
        readonly runtimeOperations?: LocalSessionOperations;
        readonly nowEpochMilliseconds: () => number;
    };
    readonly logger: {
        readonly error: Console["error"];
        readonly info: Console["info"];
        readonly warn: Console["warn"];
    };
}

function createPairings(cx: PairingInfrastructure) {
    const identities = new ComputerIdentityService(cx.identityStores, cx.stores, cx.projects);
    return new PairingDirectoryService({
        gateways: { machineAccounts: cx.machineAccounts },
        storages: {
            forProject: (project) => cx.stores.resolve(project.computerId),
            projectDirectory: cx.projects,
        },
        services: { identities, projectAuthentication: cx.authentication.projects },
    });
}

function createHttpContext(infrastructure: RelayInfrastructure, pairings: PairingDirectoryService) {
    const cx = {
        logger: infrastructure.logger,
        services: { pairings },
        gateways: {
            ...infrastructure.gateways,
        },
    };
    return Object.freeze({
        ...cx,
        services: Object.freeze({
            pairings,
            computerPairings: new PairingService(cx),
            computerConnections: new ComputerConnectionService(cx),
        }),
    });
}

export type RelayContext = ReturnType<typeof createHttpContext>;

export function createRelayDependencies(infrastructure: RelayInfrastructure): RelayContext;
export function createRelayDependencies(infrastructure: RelayInfrastructure) {
    const pairings = createPairings(infrastructure);
    return createHttpContext(infrastructure, pairings);
}
