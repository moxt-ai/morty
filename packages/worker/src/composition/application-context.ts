import { logger } from "@morty-build/relay/logging";
import type { Logger } from "pino";
import type { ComputerBackendService } from "../../../relay/src/components/computer/service/computer-backend-service.ts";
import { ChatService } from "../components/chat/service/chat-service.ts";
import { AuthenticationService } from "../components/management/service/authentication-service.ts";
import { LocalComputerService } from "../components/management/service/local-computer-service.ts";
import { ManagementService } from "../components/management/service/management-service.ts";
import { IdentityStorage } from "../components/management/storage/identity-storage.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { accountProvisioner } from "./account-provisioning.ts";

// One logger, whose error serializer keeps credentials and request input out of the logs.
export { logger };

export interface ApplicationContext {
    readonly config: { readonly bindings: CloudBindings };
    readonly logger: Logger;
    readonly storages: {
        readonly identities: IdentityStorage;
    };
    readonly services: {
        readonly computers: LocalComputerService;
        readonly authentication: AuthenticationService;
        readonly chat: ChatService;
        readonly management: ManagementService;
    };
}

export function createApplicationDependencies(
    bindings: CloudBindings,
    computer: ComputerBackendService,
): ApplicationContext {
    const infrastructure = {
        config: { bindings },
        sessionOperations: bindings.CHAT_SESSION_OPERATIONS,
        logger,
    };
    const storages = Object.freeze({
        identities: new IdentityStorage(
            bindings.DATABASE,
            bindings.CHAT_COMPUTER_ID ?? null,
            bindings.CHAT_OWNER_USER_ID ?? null,
        ),
    });
    const cx = { ...infrastructure, storages };
    const authentication = new AuthenticationService(cx);
    const computers = new LocalComputerService(bindings, computer);
    const services = Object.freeze({
        computers,
        authentication,
        chat: new ChatService({ ...cx, services: { computers } }),
        management: new ManagementService({
            ...cx,
            services: { authentication, computers, provisionAccount: accountProvisioner(bindings) },
        }),
    });
    return Object.freeze({ ...cx, services });
}
