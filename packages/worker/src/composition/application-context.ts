import pino, { type Logger } from "pino";
import { ChatService } from "../components/chat/service/chat-service.ts";
import { MobiusAppService } from "../components/chat/service/mobius-app-service.ts";
import { ManagedSessionStorage } from "../components/chat/storage/managed-session-storage.ts";
import { AuthenticationService } from "../components/management/service/authentication-service.ts";
import { ManagementService } from "../components/management/service/management-service.ts";
import { ConfigurationStorage } from "../components/management/storage/configuration-storage.ts";
import { IdentityStorage } from "../components/management/storage/identity-storage.ts";
import { ManagedBotStorage } from "../components/management/storage/managed-bot-storage.ts";
import { PlatformProjectStorage } from "../components/management/storage/platform-project-storage.ts";
import { ClerkGateway } from "../gateway/clerk-gateway.ts";
import { PlatformProjectGateway } from "../gateway/platform-project-gateway.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { projectBindings } from "./project-bindings.ts";

const logger = pino({
    base: { service: "mobius-chat" },
    browser: { asObject: true },
    level: "info",
});

export interface ApplicationContext {
    readonly config: { readonly bindings: CloudBindings };
    readonly gateways: { readonly clerk: ClerkGateway; readonly platformProjects: PlatformProjectGateway };
    readonly logger: Logger;
    readonly storages: {
        readonly configuration: ConfigurationStorage;
        readonly identities: IdentityStorage;
        readonly managedBots: ManagedBotStorage;
        readonly chatSessions: ManagedSessionStorage;
        readonly platformProjects: PlatformProjectStorage;
    };
    readonly services: {
        readonly authentication: AuthenticationService;
        readonly chat: ChatService;
        readonly mobiusApp: MobiusAppService;
        readonly management: ManagementService;
    };
}

export function createApplicationDependencies(bindings: CloudBindings): ApplicationContext {
    const infrastructure = {
        config: { bindings },
        gateways: { clerk: new ClerkGateway(), platformProjects: new PlatformProjectGateway(bindings) },
        logger,
    };
    const storages = Object.freeze({
        configuration: new ConfigurationStorage(infrastructure),
        identities: new IdentityStorage(bindings.DATABASE, bindings.CHAT_PROJECT_ID ?? null),
        managedBots: new ManagedBotStorage(bindings.DATABASE),
        chatSessions: new ManagedSessionStorage(bindings.DATABASE),
        platformProjects: new PlatformProjectStorage(bindings.DATABASE),
    });
    const cx = { ...infrastructure, storages };
    const authentication = new AuthenticationService(cx);
    const mobiusApp = new MobiusAppService({
        appId: bindings.MOBIUS_APP_ID,
        appSecret: bindings.MOBIUS_APP_SECRET,
        baseUrl: bindings.MOBIUS_BASE_URL,
        forbiddenOrigin: bindings.APP_ORIGIN,
        metrics: logger,
        nowMilliseconds: () => performance.now(),
    });
    const services = Object.freeze({
        authentication,
        chat: new ChatService({ ...cx, services: { mobiusApp } }),
        mobiusApp,
        management: new ManagementService({
            ...cx,
            services: { authentication, mobiusApp },
            scopeProject: async (projectId, signal): Promise<ManagementService> =>
                createApplicationDependencies(await projectBindings(bindings, projectId, signal)).services.management,
        }),
    });
    return Object.freeze({ ...cx, services });
}
