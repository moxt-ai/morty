import type { CloudflareChannelRuntime } from "../../../worker/src/gateway/cloudflare-channel-runtime.ts";
import { ChannelService } from "../components/management/service/channel-service.ts";
import type { ComputerManagementService } from "../components/management/service/computer-management-service.ts";
import type { ComputerManagementStorageDirectory } from "../components/management/service/computer-management-storage-directory.ts";
import { PairingDirectoryService } from "../components/management/service/pairing-directory-service.ts";
import { ComputerIdentityService } from "../components/management/service/pairing-identity-service.ts";
import { PairingService } from "../components/management/service/pairing-service.ts";
import type { ProjectStore, ProjectStoreResolver } from "../components/management/storage/project-store.ts";

export function createRelayDependencies(infrastructure: {
    readonly control: ComputerManagementService;
    readonly stores: ProjectStoreResolver;
    readonly projects: ComputerManagementStorageDirectory;
    readonly identityStores: readonly ProjectStore[];
    readonly gateways: {
        readonly channelGateway: CloudflareChannelRuntime;
        readonly nowEpochMilliseconds: () => number;
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
        services: { pairings, runtimePairings: new PairingService(cx), channels: new ChannelService(cx) },
    };
}

export type RelayContext = ReturnType<typeof createRelayDependencies>;
