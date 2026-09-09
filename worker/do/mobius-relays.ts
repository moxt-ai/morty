import {
    CloudflareSessionTransport,
    DurableObjectSqlDatabase,
    R2ContentStore,
    sessionQuotaFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare/adapters";
import { createDurableObjectDependencies } from "@moxt-ai/mobius-relay-core";
import { CloudflareBotConnectionRuntime } from "../../mobius/packages/relay-cloudflare/src/cloudflare-bot-connection-runtime.ts";
import { CloudflareChannelPeers } from "../../mobius/packages/relay-cloudflare/src/cloudflare-channel-peers.ts";
import { BotConnectionActor as BotConnectionImplementation } from "../../mobius/packages/relay-cloudflare/src/durable-objects/bot-connection-actor.ts";
import { RuntimeRelay as RuntimeRelayImplementation } from "../../mobius/packages/relay-cloudflare/src/durable-objects/runtime-relay.ts";
import { SessionRelay as SessionRelayImplementation } from "../../mobius/packages/relay-cloudflare/src/durable-objects/session-relay.ts";
import { createMobiusStorage } from "../di/mobius-storage.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";

type RelayBindings = CloudBindings & {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly SESSION_RELAY: DurableObjectNamespace;
    readonly SESSION_ACTIVE_SESSIONS_PER_PROJECT?: string;
    readonly SESSION_ACTIVE_SESSIONS_PER_TENANT?: string;
};

function createContext(state: DurableObjectState, bindings: RelayBindings) {
    const storage = createMobiusStorage(bindings);
    return createDurableObjectDependencies({
        doDatabase: new DurableObjectSqlDatabase(state.storage),
        content: { kind: "external", content: new R2ContentStore(storage.buckets, storage.tenants, "mobius/") },
        quota: sessionQuotaFromEnvironment(bindings),
        gateways: {
            connections: new CloudflareBotConnectionRuntime(bindings.BOT_CONNECTIONS),
            tenantShardingDirectory: storage.tenants,
            databaseResolver: storage.databases,
            sessionTransport: new CloudflareSessionTransport(bindings.SESSION_RELAY),
            peers: new CloudflareChannelPeers(state),
            schedule: async (timestamp, signal) => {
                signal.throwIfAborted();
                await state.storage.setAlarm(timestamp);
                signal.throwIfAborted();
            },
        },
    });
}

export class RuntimeRelay extends RuntimeRelayImplementation {
    constructor(state: DurableObjectState, bindings: RelayBindings) {
        super(createContext(state, bindings));
    }
}

export class SessionRelay extends SessionRelayImplementation {
    constructor(state: DurableObjectState, bindings: RelayBindings) {
        super(createContext(state, bindings));
    }
}

export class BotConnectionActor extends BotConnectionImplementation {
    constructor(state: DurableObjectState, bindings: RelayBindings) {
        super(createContext(state, bindings));
    }
}
