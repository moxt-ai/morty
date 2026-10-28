import * as v from "valibot";
import type { ManagedSessionOperations } from "../components/chat/infra/managed-session-operations.ts";

function hasMethods(value: unknown, methods: readonly string[]): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        methods.every((method) => method in value && typeof Reflect.get(value, method) === "function")
    );
}

export const d1DatabaseBindingSchema = v.custom<D1Database>((value) => hasMethods(value, ["batch", "prepare"]));

export const readableR2BucketBindingSchema = v.custom<Pick<R2Bucket, "get">>((value) => hasMethods(value, ["get"]));

export const durableObjectNamespaceBindingSchema = <T extends Rpc.DurableObjectBranded | undefined = undefined>() =>
    v.custom<DurableObjectNamespace<T>>((value) => hasMethods(value, ["get", "idFromName"]));

export const webSocketNamespaceBindingSchema = v.custom<DurableObjectNamespace>((value) =>
    hasMethods(value, ["get", "newUniqueId"]),
);

export const projectStorageBindingsSchema = v.pipe(
    v.object({
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
    readonly CHAT_WEBSOCKETS?: unknown;
    readonly CHAT_PROJECTS?: unknown;
    readonly CHAT_ATTACHMENTS_APAC?: unknown;
    readonly APP_ORIGIN?: unknown;
    readonly ASSETS?: unknown;
    readonly AUTHENTICATION_BASE_URL?: unknown;
    readonly DATABASE?: unknown;
    readonly CHAT_PROJECT_ID?: string;
    readonly CHAT_SESSION_OPERATIONS?: ManagedSessionOperations;
    readonly CHAT_REPLACEMENT_KEY?: unknown;
    readonly MOBIUS_BASE_URL?: unknown;
    readonly MOBIUS_APP_ID?: unknown;
    readonly MOBIUS_APP_SECRET?: unknown;
    readonly RUNTIME_RELAY?: unknown;
    readonly SESSION_ACTIVE_SESSIONS_PER_PROJECT?: unknown;
    readonly SESSION_ACTIVE_SESSIONS_PER_TENANT?: unknown;
}
