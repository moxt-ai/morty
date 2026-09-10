import pino from "pino";
import { MobiusAppService } from "../components/chat/mobius-app-service.ts";
import { AuthenticationService } from "../components/management/service/authentication-service.ts";
import { ConfigurationStorage } from "../components/management/storage/configuration-storage.ts";
import { IdentityStorage } from "../components/management/storage/identity-storage.ts";
import { ManagedBotStorage } from "../components/management/storage/managed-bot-storage.ts";
import { ClerkGateway } from "../gateway/clerk-gateway.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";

const logger = pino({
    base: { service: "mobius-chat" },
    browser: { asObject: true },
    level: "info",
});

export type ApplicationContext = ReturnType<typeof createApplicationDependencies>;

export function createApplicationDependencies(bindings: CloudBindings) {
    const infrastructure = {
        config: { bindings },
        gateways: { clerk: new ClerkGateway() },
        logger,
    };
    const storages = Object.freeze({
        configuration: new ConfigurationStorage(infrastructure),
        identities: new IdentityStorage(bindings.DATABASE),
        managedBots: new ManagedBotStorage(bindings.DATABASE),
    });
    const cx = { ...infrastructure, storages };
    const services = Object.freeze({
        authentication: new AuthenticationService(cx),
        mobiusApp: new MobiusAppService({
            appId: bindings.MOBIUS_APP_ID,
            appSecret: bindings.MOBIUS_APP_SECRET,
            baseUrl: bindings.MOBIUS_BASE_URL,
            forbiddenOrigin: bindings.APP_ORIGIN,
        }),
    });
    return Object.freeze({ ...cx, services });
}
