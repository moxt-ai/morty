import {
    CloudflareBotConnectionRuntime,
    CloudflareChannelRuntime,
    CloudflareSessionTransport,
    sessionQuotaFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare/adapters";
import { createBotApplication, createMobiusApplication, createRelayDependencies } from "@moxt-ai/mobius-relay-core";
import * as v from "valibot";
import { ClerkGateway } from "../gateway/clerk-gateway.ts";
import { MobiusPairingTenantResolver } from "../gateway/mobius-pairing-tenant-resolver.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { json } from "../infra/http.ts";
import { AuthenticationService } from "../service/authentication-service.ts";
import { ConfigurationStorage } from "../storage/configuration-storage.ts";
import { createMobiusStorage } from "./mobius-storage.ts";

interface MobiusBindings {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_ACTIVE_SESSIONS_PER_PROJECT?: string;
    readonly SESSION_ACTIVE_SESSIONS_PER_TENANT?: string;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

const mobiusBindingsSchema = v.object({
    BOT_CONNECTIONS: v.object({ get: v.function(), idFromName: v.function() }),
    RUNTIME_RELAY: v.object({ get: v.function(), idFromName: v.function() }),
    SESSION_ACTIVE_SESSIONS_PER_PROJECT: v.optional(v.string()),
    SESSION_ACTIVE_SESSIONS_PER_TENANT: v.optional(v.string()),
    SESSION_RELAY: v.object({ get: v.function(), idFromName: v.function() }),
});

function hasMobiusBindings(bindings: CloudBindings): bindings is CloudBindings & MobiusBindings {
    return v.safeParse(mobiusBindingsSchema, bindings).success;
}

export function isMobiusRequest(path: string): boolean {
    return path.startsWith("/mobius/api/");
}

const application = createMobiusApplication();
const botApplication = createBotApplication();

export async function fetchMobiusRequest(request: Request, bindings: CloudBindings): Promise<Response> {
    const host = { config: { bindings } };
    const storage = createMobiusStorage(bindings);
    const pairingTenantResolver = new MobiusPairingTenantResolver({
        services: {
            authentication: new AuthenticationService({
                storages: { configuration: new ConfigurationStorage(host) },
                gateways: { clerk: new ClerkGateway(host) },
            }),
        },
    });
    if (!hasMobiusBindings(bindings)) {
        return json(
            {
                error: {
                    code: "MOBIUS_UNAVAILABLE",
                    message: "Mobius is temporarily unavailable.",
                },
            },
            503,
        );
    }
    const cx = createRelayDependencies({
        bots: { connections: new CloudflareBotConnectionRuntime(bindings.BOT_CONNECTIONS) },
        ...storage,
        config: { apiPrefix: "/mobius/api", quota: sessionQuotaFromEnvironment(bindings) },
        logger: console,
        gateways: {
            nowEpochMilliseconds: () => Date.now(),
            pairingTenantResolver,
            channelGateway: new CloudflareChannelRuntime({ gateways: { runtimeRelay: bindings.RUNTIME_RELAY } }),
            sessionTransport: new CloudflareSessionTransport(bindings.SESSION_RELAY),
        },
    });
    if (new URL(request.url).pathname.startsWith("/mobius/api/v1/") && cx.services.bots !== null) {
        return await botApplication.fetch(request, { services: { bots: cx.services.bots } });
    }
    return await application.fetch(request, cx);
}
