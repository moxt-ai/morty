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

export const durableObjectNamespaceBindingSchema = <T extends Rpc.DurableObjectBranded | undefined = undefined>() =>
    v.custom<DurableObjectNamespace<T>>((value) => hasMethods(value, ["get", "idFromName"]));

export const computerStorageBindingsSchema = v.pipe(
    v.object({
        CHAT_COMPUTER_ID: v.string(),
        DATABASE: d1DatabaseBindingSchema,
    }),
    v.readonly(),
);

export type ComputerStorageBindings = v.InferOutput<typeof computerStorageBindingsSchema>;

export interface CloudBindings {
    readonly COMPUTER_RELAY?: unknown;
    readonly ANONYMOUS_CREATION_LIMITER?: unknown;
    readonly APP_ORIGIN?: unknown;
    readonly ASSETS?: unknown;
    readonly DATABASE?: unknown;
    readonly CHAT_COMPUTER_ID?: string;
    readonly CHAT_OWNER_USER_ID?: string | null;
    readonly CHAT_SESSION_OPERATIONS?: ManagedSessionOperations;
    /**
     * Commits an identity change that may end access to the computer; `change` reports whether it changed anything.
     * The computer closes the live connections the committed change ended; that never undoes or fails the change.
     */
    readonly CHAT_END_ACCESS?: (change: () => Promise<boolean>) => Promise<boolean>;
    /** The Computer object's own key for credentials that a repeated request derives again. */
    readonly CHAT_CREDENTIAL_KEY?: (signal: AbortSignal) => Promise<Uint8Array>;
    readonly RELAY_DIRECTORY_DATABASE?: unknown;
    readonly MORTY_SESSION_SIGNING_SECRET?: unknown;
    readonly MORTY_ALLOWED_ORIGINS?: unknown;
}
