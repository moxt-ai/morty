import {
    CloudflareChannelRuntime,
    CloudflareSessionRuntime,
    D1PairingGateway,
    D1PairingIdentityDirectory,
    sessionQuotaFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare/adapters";
import { createRelayApp } from "@moxt-ai/mobius-relay-core";
import * as v from "valibot";
import { CloudflareBotApi } from "../../mobius/packages/relay-cloudflare/src/bot-api.ts";
import { SingleDatabaseResolver } from "../../mobius/packages/relay-cloudflare-standalone/src/database-resolver.ts";
import { StandaloneTenantShardingDirectory } from "../../mobius/packages/relay-cloudflare-standalone/src/tenant-sharding-directory.ts";
import { ClerkGateway } from "../gateway/clerk-gateway.ts";
import { WorkspacePairingTenantResolver } from "../gateway/workspace-pairing-tenant-resolver.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { json } from "../infra/http.ts";
import { AuthenticationService } from "../service/authentication-service.ts";
import { ConfigurationStorage } from "../storage/configuration-storage.ts";

interface MobiusBindings {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly DIRECTORY_DATABASE: D1Database;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_ACTIVE_SESSIONS_PER_PROJECT?: string;
    readonly SESSION_ACTIVE_SESSIONS_PER_TENANT?: string;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

const mobiusBindingsSchema = v.object({
    BOT_CONNECTIONS: v.object({ get: v.function(), idFromName: v.function() }),
    DIRECTORY_DATABASE: v.object({ batch: v.function(), prepare: v.function() }),
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

export async function fetchMobiusRequest(request: Request, bindings: CloudBindings): Promise<Response> {
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
    const infrastructure = {
        config: { quota: sessionQuotaFromEnvironment(bindings) },
        gateways: {
            sessionRelay: bindings.SESSION_RELAY,
            databaseResolver: new SingleDatabaseResolver(bindings.DIRECTORY_DATABASE),
            tenantShardingDirectory: new StandaloneTenantShardingDirectory(),
            pairingIdentityDirectory: new D1PairingIdentityDirectory([bindings.DIRECTORY_DATABASE]),
            runtimeRelay: bindings.RUNTIME_RELAY,
        },
    };
    const sessions = new CloudflareSessionRuntime(infrastructure);
    const channelRuntime = new CloudflareChannelRuntime(infrastructure);
    const tenantResolver = new WorkspacePairingTenantResolver(
        new AuthenticationService({
            storages: { configuration: new ConfigurationStorage({ config: { bindings } }) },
            gateways: { clerk: new ClerkGateway({ config: { bindings } }) },
        }),
    );
    const bots = new CloudflareBotApi(bindings, channelRuntime, sessions, tenantResolver);
    if (bots.handles(request)) {
        return await bots.fetch(request);
    }
    const application = createRelayApp({
        channelGateway: channelRuntime,
        pairingGateway: new D1PairingGateway(infrastructure),
        pairingTenantResolver: tenantResolver,
        sessionCommands: sessions,
        sessionQueries: sessions,
        sessionTransfers: sessions,
        sessionArtifacts: sessions,
        sessionEventStreams: sessions,
    });
    return await application.fetch(request);
}
