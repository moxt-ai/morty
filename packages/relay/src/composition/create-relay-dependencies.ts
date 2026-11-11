import type { CloudflareComputerRelay } from "../../../worker/src/gateway/cloudflare-computer-relay.ts";
import { ComputerConnectionService } from "../components/management/service/computer-connection-service.ts";
import type { ComputerManagementService } from "../components/management/service/computer-management-service.ts";
import type { ComputerManagementStorageDirectory } from "../components/management/service/computer-management-storage-directory.ts";
import { PairingDirectoryService } from "../components/management/service/pairing-directory-service.ts";
import { ComputerIdentityService } from "../components/management/service/pairing-identity-service.ts";
import { PairingService } from "../components/management/service/pairing-service.ts";
import type {
    ComputerRelayStore,
    ComputerRelayStoreResolver,
} from "../components/management/storage/computer-relay-store.ts";

export function createRelayDependencies(infrastructure: {
    readonly control: ComputerManagementService;
    readonly stores: ComputerRelayStoreResolver;
    readonly projects: ComputerManagementStorageDirectory;
    readonly identityStores: readonly ComputerRelayStore[];
    readonly gateways: {
        readonly computerRelayGateway: CloudflareComputerRelay;
    };
}) {
    const identities = new ComputerIdentityService(
        infrastructure.identityStores,
        infrastructure.stores,
        infrastructure.projects,
    );
    const pairings = new PairingDirectoryService({
        storages: { forProject: (project) => infrastructure.stores.resolve(project.computerId) },
        services: {
            identities,
            projectAuthentication: infrastructure.control,
            machineAccounts: infrastructure.control,
            projects: infrastructure.projects,
        },
    });
    const cx = { services: { pairings }, gateways: infrastructure.gateways };
    return {
        ...cx,
        services: {
            pairings,
            computerPairings: new PairingService(cx),
            computerConnections: new ComputerConnectionService(cx),
        },
    };
}

export type RelayContext = ReturnType<typeof createRelayDependencies>;
