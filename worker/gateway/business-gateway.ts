import { createSlackApplication, createSlackWorker } from "@moxt-ai/app-slack-api";
import { MobiusGateway } from "@moxt-ai/app-slack-api/gateway";
import type { SlackQueueMessage } from "@moxt-ai/app-slack-api/infra";
import { MobiusFetchGateway } from "@moxt-ai/app-slack-api/infra";
import {
    CloudflareChannelRuntime,
    CloudflareSessionRuntime,
    D1PairingDirectory,
    sessionQuotaFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare/adapters";
import { createMobiusApplication } from "@moxt-ai/mobius-relay-core";
import * as v from "valibot";
import { SlackQueueController } from "../../apps/slack/packages/worker/src/controller/slack-queue-controller.ts";
import {
    createCloudflareEnvironment,
    type WorkerBindings,
} from "../../apps/slack/packages/worker/src/di/create-cloudflare-environment.ts";
import { json } from "../infra/http.ts";

export interface CloudBindings {
    readonly AGENT_TRIGGER_RATE_LIMITER?: unknown;
    readonly APP_ORIGIN?: unknown;
    readonly ASSETS?: unknown;
    readonly ATTACHMENTS?: unknown;
    readonly AUTHENTICATION_BASE_URL?: unknown;
    readonly CLERK_ISSUER_URL?: unknown;
    readonly CLERK_JWT_KEY?: unknown;
    readonly CLERK_PUBLISHABLE_KEY?: unknown;
    readonly DATABASE?: unknown;
    readonly DIRECTORY_DATABASE?: unknown;
    readonly EVENTS?: unknown;
    readonly MOBIUS_BASE_URL?: unknown;
    readonly SLACK_MOBIUS_AUTH_TOKEN?: unknown;
    readonly SLACK_OAUTH_STATE_SIGNING_KEY?: unknown;
    readonly SLACK_SERVER_BASE_URL?: unknown;
    readonly SLACK_TOKEN_ENCRYPTION_KEY?: unknown;
    readonly RUNTIME_RELAY?: unknown;
    readonly SESSION_ACTIVE_SESSIONS_PER_PROJECT?: unknown;
    readonly SESSION_ACTIVE_SESSIONS_PER_TENANT?: unknown;
    readonly SESSION_RELAY?: unknown;
}

interface MobiusBindings {
    readonly DIRECTORY_DATABASE: D1Database;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_ACTIVE_SESSIONS_PER_PROJECT?: string;
    readonly SESSION_ACTIVE_SESSIONS_PER_TENANT?: string;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

const slackBindingsSchema = v.object({
    AGENT_TRIGGER_RATE_LIMITER: v.object({
        get: v.function(),
        idFromName: v.function(),
    }),
    ASSETS: v.object({ fetch: v.function() }),
    ATTACHMENTS: v.object({ get: v.function(), put: v.function() }),
    AUTHENTICATION_BASE_URL: v.pipe(v.string(), v.url()),
    CLERK_ISSUER_URL: v.pipe(v.string(), v.url()),
    CLERK_JWT_KEY: v.string(),
    CLERK_PUBLISHABLE_KEY: v.string(),
    DATABASE: v.object({ batch: v.function(), prepare: v.function() }),
    EVENTS: v.object({ send: v.function() }),
    MOBIUS_BASE_URL: v.pipe(v.string(), v.url()),
    SLACK_MOBIUS_AUTH_TOKEN: v.pipe(v.string(), v.minLength(1)),
    SLACK_OAUTH_STATE_SIGNING_KEY: v.pipe(v.string(), v.minLength(1)),
    SLACK_SERVER_BASE_URL: v.pipe(v.string(), v.url()),
    SLACK_TOKEN_ENCRYPTION_KEY: v.pipe(v.string(), v.minLength(1)),
});

function hasSlackBindings(bindings: CloudBindings): bindings is CloudBindings & WorkerBindings {
    return v.safeParse(slackBindingsSchema, bindings).success;
}

const mobiusBindingsSchema = v.object({
    DIRECTORY_DATABASE: v.object({ batch: v.function(), prepare: v.function() }),
    RUNTIME_RELAY: v.object({ get: v.function(), idFromName: v.function() }),
    SESSION_ACTIVE_SESSIONS_PER_PROJECT: v.optional(v.string()),
    SESSION_ACTIVE_SESSIONS_PER_TENANT: v.optional(v.string()),
    SESSION_RELAY: v.object({ get: v.function(), idFromName: v.function() }),
});

class CloudMobiusFetchGateway extends MobiusFetchGateway {
    readonly #bindings: CloudBindings;

    constructor(baseUrl: string, bindings: CloudBindings) {
        super(baseUrl);
        this.#bindings = bindings;
    }

    override readonly fetch = async (path: string, init?: RequestInit): Promise<Response> => {
        const configured = v.parse(slackBindingsSchema, this.#bindings);
        const configuredUrl = new URL(configured.MOBIUS_BASE_URL);
        const requestedUrl = new URL(path, configuredUrl);
        if (!path.startsWith("/") || requestedUrl.origin !== configuredUrl.origin) {
            return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
        }
        if (isMobiusRequest(requestedUrl.pathname)) {
            return await fetchMobiusRequest(new Request(requestedUrl, init), this.#bindings);
        }
        return await fetch(new Request(requestedUrl, init));
    };
}

function hasMobiusBindings(bindings: CloudBindings): bindings is CloudBindings & MobiusBindings {
    return v.safeParse(mobiusBindingsSchema, bindings).success;
}

function isMobiusRequest(path: string): boolean {
    return path.startsWith("/mobius/api/");
}

async function fetchMobiusRequest(request: Request, bindings: CloudBindings): Promise<Response> {
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
    const injector = createMobiusApplication({
        channelRuntime: new CloudflareChannelRuntime(bindings.RUNTIME_RELAY),
        pairingDirectory: new D1PairingDirectory(bindings.DIRECTORY_DATABASE),
        sessionRuntime: new CloudflareSessionRuntime(
            bindings.SESSION_RELAY,
            bindings.DIRECTORY_DATABASE,
            sessionQuotaFromEnvironment(bindings),
        ),
    });
    return await injector.resolve("application").fetch(request);
}

const slackWorker = createSlackWorker<
    CloudBindings & WorkerBindings,
    ExecutionContext | undefined,
    MessageBatch<SlackQueueMessage>
>((bindings) => {
    const composition = createSlackApplication(createCloudflareEnvironment(bindings));
    const injector = composition.create(
        composition.injector
            .provideValue("mobiusFetchGateway", new CloudMobiusFetchGateway(bindings.MOBIUS_BASE_URL, bindings))
            .provideClass("mobius", MobiusGateway),
    );
    return {
        fetchApi: async (request, environment, context) =>
            await injector.resolve("application").fetch(request, environment, context),
        fetchFile: injector.resolve("slackFileController").fetch,
        consumeQueue: new SlackQueueController(injector.resolve("queueConsumer"), injector.resolve("logger")).consume,
    };
});

export class BusinessGateway {
    static readonly inject = ["bindings"] as const;

    private readonly bindings: CloudBindings;

    constructor(bindings: CloudBindings) {
        this.bindings = bindings;
    }

    readonly fetch = async (request: Request, context?: ExecutionContext): Promise<Response> => {
        const bindings = this.bindings;
        const path = new URL(request.url).pathname;
        if (path.startsWith("/mobius-slack/api/")) {
            if (!hasSlackBindings(bindings)) {
                return json(
                    {
                        error: {
                            code: "SLACK_UNAVAILABLE",
                            message: "Slack integration is temporarily unavailable.",
                        },
                    },
                    503,
                );
            }
            return await slackWorker.fetch(request, bindings, context);
        }
        if (isMobiusRequest(path)) {
            return await fetchMobiusRequest(request, bindings);
        }
        return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    };

    readonly consumeQueue = async (batch: MessageBatch<SlackQueueMessage>): Promise<void> => {
        const bindings = this.bindings;
        if (!hasSlackBindings(bindings)) {
            throw new Error("Slack queue configuration is unavailable.");
        }
        await slackWorker.queue(batch, bindings);
    };
}
