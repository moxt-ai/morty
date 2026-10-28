import pino, { type Logger } from "pino";
import { ChatService } from "../components/chat/service/chat-service.ts";
import { ManagedSessionStorage } from "../components/chat/storage/managed-session-storage.ts";
import { AuthenticationService } from "../components/management/service/authentication-service.ts";
import { ManagementService } from "../components/management/service/management-service.ts";
import { IdentityStorage } from "../components/management/storage/identity-storage.ts";
import { ManagedBotStorage } from "../components/management/storage/managed-bot-storage.ts";
import { PlatformProjectStorage } from "../components/management/storage/platform-project-storage.ts";
import { PlatformProjectGateway } from "../gateway/platform-project-gateway.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { projectBindings } from "./project-bindings.ts";

const logger = pino({
    base: { service: "morty" },
    browser: { asObject: true },
    level: "info",
});

export interface ApplicationContext {
    readonly config: { readonly bindings: CloudBindings };
    readonly gateways: { readonly platformProjects: PlatformProjectGateway };
    readonly logger: Logger;
    readonly storages: {
        readonly identities: IdentityStorage;
        readonly managedBots: ManagedBotStorage;
        readonly chatSessions: ManagedSessionStorage;
        readonly platformProjects: PlatformProjectStorage;
    };
    readonly services: {
        readonly authentication: AuthenticationService;
        readonly chat: ChatService;
        readonly management: ManagementService;
    };
}

export function createApplicationDependencies(bindings: CloudBindings): ApplicationContext {
    const infrastructure = {
        config: { bindings },
        sessionOperations: bindings.CHAT_SESSION_OPERATIONS,
        gateways: { platformProjects: new PlatformProjectGateway(bindings) },
        logger,
    };
    const storages = Object.freeze({
        identities: new IdentityStorage(bindings.DATABASE, bindings.CHAT_PROJECT_ID ?? null),
        managedBots: new ManagedBotStorage(bindings.DATABASE),
        chatSessions: new ManagedSessionStorage(bindings.DATABASE),
        platformProjects: new PlatformProjectStorage(bindings.DATABASE),
    });
    const cx = { ...infrastructure, storages };
    const authentication = new AuthenticationService(cx);
    const services = Object.freeze({
        authentication,
        chat: new ChatService(cx),
        management: new ManagementService({
            ...cx,
            services: { authentication },
            scopeProject: async (projectId, signal): Promise<ManagementService> =>
                createApplicationDependencies(await projectBindings(bindings, projectId, signal)).services.management,
        }),
    });
    return Object.freeze({ ...cx, services });
}
