import * as v from "valibot";
import type { RequestAccessMetrics } from "./request-access-metrics.ts";

function hasMethods(value: unknown, methods: readonly string[]): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        methods.every((method) => method in value && typeof Reflect.get(value, method) === "function")
    );
}

export const d1DatabaseBindingSchema = v.custom<D1Database>((value) => hasMethods(value, ["batch", "prepare"]));

export const readableR2BucketBindingSchema = v.custom<Pick<R2Bucket, "get">>((value) => hasMethods(value, ["get"]));

export const r2BucketBindingSchema = v.custom<R2Bucket>((value) => hasMethods(value, ["get", "put"]));

export const fetcherBindingSchema = v.custom<Fetcher>((value) => hasMethods(value, ["fetch"]));

export const durableObjectNamespaceBindingSchema = <T extends Rpc.DurableObjectBranded | undefined = undefined>() =>
    v.custom<DurableObjectNamespace<T>>((value) => hasMethods(value, ["get", "idFromName"]));

export const queueBindingSchema = <Message>() => v.custom<Queue<Message>>((value) => hasMethods(value, ["send"]));

export const projectStorageBindingsSchema = v.pipe(
    v.object({
        ATTACHMENTS: r2BucketBindingSchema,
        CHAT_PROJECT_ID: v.string(),
        DATABASE: d1DatabaseBindingSchema,
    }),
    v.readonly(),
);

export type ProjectStorageBindings = v.InferOutput<typeof projectStorageBindingsSchema>;

export const platformEndpointBindingsSchema = v.pipe(
    v.object({
        MOBIUS_APP_ID: v.string(),
        MOBIUS_BASE_URL: v.string(),
    }),
    v.readonly(),
);

export const appOriginBindingSchema = v.pipe(v.object({ APP_ORIGIN: v.string() }), v.readonly());

export const platformCredentialBindingsSchema = v.pipe(v.object({ MOBIUS_APP_SECRET: v.string() }), v.readonly());

export interface CloudBindings {
    readonly CHAT_PROJECTS?: unknown;
    readonly CHAT_ATTACHMENTS_APAC?: unknown;
    readonly CHAT_ATTACHMENTS_WNAM?: unknown;
    readonly ATTACHMENTS?: unknown;
    readonly BOT_TRIGGER_RATE_LIMITER?: unknown;
    readonly APP_ORIGIN?: unknown;
    readonly ASSETS?: unknown;
    readonly AUTHENTICATION_BASE_URL?: unknown;
    readonly CLERK_JWT_KEY?: unknown;
    readonly CLERK_PUBLISHABLE_KEY?: unknown;
    readonly DATABASE?: unknown;
    readonly CHAT_PROJECT_ID?: string;
    readonly EVENTS?: unknown;
    readonly MOBIUS_BASE_URL?: unknown;
    readonly MOBIUS_APP_ID?: unknown;
    readonly MOBIUS_APP_SECRET?: unknown;
    readonly SLACK_MOBIUS_AUTH_TOKEN?: unknown;
    readonly SLACK_OAUTH_STATE_SIGNING_KEY?: unknown;
    readonly SLACK_SERVER_BASE_URL?: unknown;
    readonly SLACK_TOKEN_ENCRYPTION_KEY?: unknown;
    readonly RUNTIME_RELAY?: unknown;
    readonly SESSION_ACTIVE_SESSIONS_PER_PROJECT?: unknown;
    readonly SESSION_ACTIVE_SESSIONS_PER_TENANT?: unknown;
    readonly requestAccessMetrics?: RequestAccessMetrics;
}
