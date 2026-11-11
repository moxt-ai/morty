import type { ComputerAccessAuthorizer } from "../entity/authentication/computer-authorization.ts";
import type { ComputerGateway } from "../gateway/computer-gateway.ts";
import type { ComputerStorageDirectory } from "../infra/computer-storage-directory.ts";
import type { ComputerStore, ComputerStoreResolver } from "../infra/computer-store.ts";
import type { MachineAccountDirectory } from "../infra/machine-account-directory.ts";
import { ComputerCatalogService } from "../service/computer/computer-catalog-service.ts";
import type { LocalSessionOperations } from "../service/computer/local-session-operations.ts";
import { PairingDirectoryService } from "../service/pairing/pairing-directory-service.ts";
import { ComputerIdentityService } from "../service/pairing/pairing-identity-service.ts";
import { PairingService } from "../service/pairing/pairing-service.ts";

interface PairingInfrastructure {
    readonly authentication: { readonly computers: ComputerAccessAuthorizer };
    readonly machineAccounts: MachineAccountDirectory;
    readonly stores: ComputerStoreResolver;
    readonly computers: ComputerStorageDirectory;
    /** The Computer stores this execution searches to find the Computer a credential belongs to. */
    readonly identityStores: readonly ComputerStore[];
}

export interface RelayInfrastructure extends PairingInfrastructure {
    readonly authentication: { readonly computers: ComputerAccessAuthorizer };
    readonly gateways: {
        readonly computerGateway: ComputerGateway;
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
    const identities = new ComputerIdentityService(cx.identityStores, cx.stores, cx.computers);
    return new PairingDirectoryService({
        gateways: { machineAccounts: cx.machineAccounts },
        storages: {
            forComputer: (computer) => cx.stores.resolve(computer.computerId),
            computerDirectory: cx.computers,
        },
        services: { identities, computerAuthentication: cx.authentication.computers },
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
            runtimePairings: new PairingService(cx),
            computerCatalog: new ComputerCatalogService(cx),
        }),
    });
}

export type RelayContext = ReturnType<typeof createHttpContext>;

export function createRelayDependencies(infrastructure: RelayInfrastructure): RelayContext;
export function createRelayDependencies(infrastructure: RelayInfrastructure) {
    const pairings = createPairings(infrastructure);
    return createHttpContext(infrastructure, pairings);
}
