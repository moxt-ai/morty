import * as v from "valibot";
import { createStore } from "zustand/vanilla";
import { type Connection, type ManagementRequests, managementError, registrationSchema } from "../requests/management";

type IntegrationCardState =
    | { readonly status: "loading" }
    | { readonly status: "error"; readonly message: string }
    | { readonly status: "summary"; readonly connection: Connection }
    | {
          readonly status: "setup";
          readonly connection: Connection;
          readonly error: string | null;
          readonly manifest: string | null;
      }
    | { readonly status: "submitting"; readonly connection: Connection };

export interface IntegrationCardStore {
    readonly state: IntegrationCardState;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly openSetup: () => void;
    readonly closeSetup: () => void;
    readonly manifest: (name: string, signal: AbortSignal) => Promise<void>;
    readonly connect: (fields: unknown, signal: AbortSignal) => Promise<string | null>;
    readonly connectAutomatically: (name: string, refreshToken: string, signal: AbortSignal) => Promise<string | null>;
    readonly disconnect: (signal: AbortSignal) => Promise<void>;
}

export const createIntegrationCardStore = (
    botId: string,
    requests: ManagementRequests,
    mode: "existing" | "new" = "existing",
) =>
    createStore<IntegrationCardStore>()((set, get) => {
        const load = async (signal: AbortSignal): Promise<void> => {
            try {
                const connection = await requests.getConnection(botId, signal);
                signal.throwIfAborted();
                set({ state: { status: "summary", connection } });
            } catch (error) {
                if (!signal.aborted) {
                    set({ state: { status: "error", message: managementError(error) } });
                }
            }
        };
        return {
            state:
                mode === "new"
                    ? { status: "setup", connection: { kind: "not-configured" }, error: null, manifest: null }
                    : { status: "loading" },
            load,
            openSetup: () => {
                const current = get().state;
                if (current.status === "summary") {
                    set({ state: { status: "setup", connection: current.connection, error: null, manifest: null } });
                }
            },
            closeSetup: () => {
                const current = get().state;
                if (current.status === "setup") {
                    set({ state: { status: "summary", connection: current.connection } });
                }
            },
            manifest: async (name, signal) => {
                const current = get().state;
                if (current.status !== "setup") {
                    return;
                }
                try {
                    const manifest = await requests.getManifest(name, signal);
                    signal.throwIfAborted();
                    const latest = get().state;
                    if (latest.status === "setup") {
                        set({ state: { ...latest, manifest: JSON.stringify(manifest, null, 2), error: null } });
                    }
                } catch (error) {
                    if (!signal.aborted) {
                        set({ state: { ...current, error: managementError(error) } });
                    }
                }
            },
            connect: async (fields, signal) => {
                const current = get().state;
                if (current.status !== "setup" && current.status !== "summary") {
                    return null;
                }
                set({ state: { status: "submitting", connection: current.connection } });
                try {
                    const destination =
                        fields === null
                            ? await requests.getAuthorizationUrl(botId, signal)
                            : await requests.registerApp(botId, v.parse(registrationSchema, fields), signal);
                    signal.throwIfAborted();
                    await load(signal);
                    return destination;
                } catch (error) {
                    if (!signal.aborted) {
                        set({
                            state: {
                                status: "setup",
                                connection: current.connection,
                                error: managementError(error),
                                manifest: null,
                            },
                        });
                    }
                    return null;
                }
            },
            connectAutomatically: async (name, refreshToken, signal) => {
                const current = get().state;
                if (current.status !== "setup") {
                    return null;
                }
                set({ state: { status: "submitting", connection: current.connection } });
                try {
                    await requests.saveConfigToken(refreshToken, signal);
                    const destination = await requests.createApp(botId, name, signal);
                    signal.throwIfAborted();
                    await load(signal);
                    return destination;
                } catch (error) {
                    if (!signal.aborted) {
                        set({
                            state: {
                                status: "setup",
                                connection: current.connection,
                                error: managementError(error),
                                manifest: null,
                            },
                        });
                    }
                    return null;
                }
            },
            disconnect: async (signal) => {
                const current = get().state;
                if (current.status !== "summary") {
                    return;
                }
                set({ state: { status: "submitting", connection: current.connection } });
                try {
                    await requests.disconnectApp(botId, signal);
                    await load(signal);
                } catch (error) {
                    if (!signal.aborted) {
                        set({ state: { status: "error", message: managementError(error) } });
                    }
                }
            },
        };
    });
