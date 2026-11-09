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
        CHAT_COMPUTER_ID: v.string(),
        DATABASE: d1DatabaseBindingSchema,
    }),
    v.readonly(),
);

export type ProjectStorageBindings = v.InferOutput<typeof projectStorageBindingsSchema>;

export const platformEndpointBindingsSchema = v.pipe(
    v.object({
        MORTY_RELAY_URL: v.string(),
    }),
    v.readonly(),
);

export const appOriginBindingSchema = v.pipe(v.object({ APP_ORIGIN: v.string() }), v.readonly());

export const platformCredentialBindingsSchema = v.pipe(v.object({ MORTY_SERVICE_SECRET: v.string() }), v.readonly());

export interface CloudBindings {
    readonly CHAT_WEBSOCKETS?: unknown;
    readonly COMPUTER_RELAY?: unknown;
    readonly CHAT_ATTACHMENTS_APAC?: unknown;
    readonly ANONYMOUS_CREATION_LIMITER?: unknown;
    readonly APP_ORIGIN?: unknown;
    readonly ASSETS?: unknown;
    readonly DATABASE?: unknown;
    readonly CHAT_COMPUTER_ID?: string;
    readonly CHAT_SESSION_OPERATIONS?: ManagedSessionOperations;
    /** The Project object's own key for credentials that a repeated request derives again. */
    readonly CHAT_CREDENTIAL_KEY?: (signal: AbortSignal) => Promise<Uint8Array>;
    readonly MORTY_RELAY_URL?: unknown;
    readonly MORTY_SERVICE_SECRET?: unknown;
}
