import type { ComputerAccounts } from "../../contracts/computer-accounts.ts";
import { ComputerManagementError } from "../../contracts/computer-management.ts";
import type { RelayBindings } from "../../contracts/relay-bindings.ts";
import { ComputerConnectionService } from "../components/management/service/computer-connection-service.ts";
import { ComputerManagementService } from "../components/management/service/computer-management-service.ts";
import { PairingDirectoryService } from "../components/management/service/pairing-directory-service.ts";
import { ComputerIdentityService } from "../components/management/service/pairing-identity-service.ts";
import { PairingService } from "../components/management/service/pairing-service.ts";
import { ComputerManagementStorage } from "../components/management/storage/computer-management-storage.ts";
import type { ComputerManagementStore } from "../components/management/storage/computer-management-store.ts";
import { SessionAccessSigner } from "../components/runtime/entity/session-access-credential.ts";
import type { ComputerService } from "../components/runtime/service/computer-service.ts";
import { SessionAccessService } from "../components/runtime/service/session-access-service.ts";

/** All stores and Runtime operations belong to this object; no loopback HTTP or remote-store fallback. */
export function createComputerRelayServices(
    bindings: RelayBindings,
    computerId: string,
    store: ComputerManagementStore,
    runtime: ComputerService,
    accounts: ComputerAccounts,
) {
    const forComputer = (id: string) => {
        if (id !== computerId) {
            throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
        }
        return store;
    };
    const storage = new ComputerManagementStorage(accounts, { forProject: forComputer });
    const control = new ComputerManagementService(storage);
    const sessionAccess = new SessionAccessService(
        control,
        new SessionAccessSigner(bindings.MORTY_SESSION_SIGNING_SECRET),
    );
    const pairings = new PairingDirectoryService({
        computerId,
        store,
        services: {
            identities: new ComputerIdentityService(computerId, store, control),
            computerAccounts: control,
        },
    });
    const context = { services: { pairings, runtime } };
    return {
        access: { sessionAccess },
        relay: {
            services: {
                pairings,
                runtime,
                computerPairings: new PairingService(context),
                computerConnections: new ComputerConnectionService(context),
            },
        },
    };
}

export type RelayContext = ReturnType<typeof createComputerRelayServices>["relay"];
