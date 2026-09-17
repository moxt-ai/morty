import {
    MobiusApiError,
    type MobiusBotConnectionDirectory,
    type MobiusBotConnectionGrant,
    type MobiusBotOwnerClient,
    type MobiusOwnerBotConnection,
} from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";

export const CONNECTOR_SCOPES = Object.freeze([
    "conversation-events:read",
    "inbound-conversation:create",
    "inbound-message:create",
    "outbound-message:ack",
    "outbound-message:read",
    "turn:cancel",
]);

type ConnectionDirectoryState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly directory: MobiusBotConnectionDirectory }
    | { readonly kind: "failed"; readonly message: string };
type ConnectionGrantState =
    | { readonly kind: "idle" }
    | { readonly kind: "creating" }
    | { readonly kind: "ready"; readonly grant: MobiusBotConnectionGrant }
    | { readonly kind: "failed"; readonly message: string };
type ConnectionGrantFormState =
    | { readonly kind: "closed" }
    | { readonly kind: "editing"; readonly audience: string; readonly label: string };

export interface BotConnectionsStore {
    readonly busyResourceId: string;
    readonly copyAnnouncement: string;
    readonly directory: ConnectionDirectoryState;
    readonly grant: ConnectionGrantState;
    readonly grantForm: ConnectionGrantFormState;
    readonly operationError: string;
    readonly revokeConfirmationId: string;
    readonly approveTarget: (deliveryTargetId: string, revision: number, signal: AbortSignal) => Promise<void>;
    readonly closeGrantForm: () => void;
    readonly confirmRevocation: (connectionId: string) => void;
    readonly copyGrant: () => Promise<void>;
    readonly createGrant: (signal: AbortSignal) => Promise<void>;
    readonly loadConnections: (signal: AbortSignal) => Promise<void>;
    readonly openGrantForm: () => void;
    readonly revokeConnection: (connection: MobiusOwnerBotConnection, signal: AbortSignal) => Promise<void>;
    readonly setAudience: (value: string) => void;
    readonly setLabel: (value: string) => void;
}

function failureMessage(error: unknown): string {
    return error instanceof MobiusApiError ? `${error.code}: ${error.message}` : "The connection request failed.";
}

export const createBotConnectionsStore = (botId: string, client: MobiusBotOwnerClient) =>
    createStore<BotConnectionsStore>()((set, get) => {
        const loadConnections = async (signal: AbortSignal): Promise<void> => {
            set({ directory: { kind: "loading" } });
            try {
                const directory = await client.listConnections(botId, signal);
                signal.throwIfAborted();
                set({ directory: { directory, kind: "ready" } });
            } catch (error) {
                if (!signal.aborted) {
                    set({ directory: { kind: "failed", message: failureMessage(error) } });
                }
            }
        };
        return {
            busyResourceId: "",
            copyAnnouncement: "",
            directory: { kind: "loading" },
            grant: { kind: "idle" },
            grantForm: { kind: "closed" },
            operationError: "",
            revokeConfirmationId: "",
            approveTarget: async (deliveryTargetId, revision, signal) => {
                set({ busyResourceId: deliveryTargetId, operationError: "" });
                try {
                    await client.approveDeliveryTarget(botId, deliveryTargetId, revision, signal);
                    await loadConnections(signal);
                } catch (error) {
                    if (!signal.aborted) {
                        set({ operationError: failureMessage(error) });
                    }
                } finally {
                    if (!signal.aborted) {
                        set({ busyResourceId: "" });
                    }
                }
            },
            closeGrantForm: () => set({ copyAnnouncement: "", grant: { kind: "idle" }, grantForm: { kind: "closed" } }),
            confirmRevocation: (revokeConfirmationId) => set({ revokeConfirmationId }),
            copyGrant: async () => {
                const grant = get().grant;
                if (grant.kind !== "ready") {
                    return;
                }
                try {
                    await navigator.clipboard.writeText(
                        JSON.stringify({
                            audience: grant.grant.audience,
                            grantId: grant.grant.grantId,
                            grantSecret: grant.grant.grantSecret,
                        }),
                    );
                    set({ copyAnnouncement: "Connection grant copied." });
                } catch {
                    set({ copyAnnouncement: "Copy was unavailable. Select the grant ID and secret manually." });
                }
            },
            createGrant: async (signal) => {
                const form = get().grantForm;
                if (form.kind !== "editing") {
                    return;
                }
                if (form.audience.trim().length === 0 || form.label.trim().length === 0) {
                    set({
                        grant: { kind: "failed", message: "Enter both a connector audience and a connection label." },
                    });
                    return;
                }
                set({ copyAnnouncement: "", grant: { kind: "creating" } });
                try {
                    const grant = await client.createConnectionGrant(
                        botId,
                        {
                            audience: form.audience.trim(),
                            expiresInSeconds: 600,
                            label: form.label.trim(),
                            scopes: CONNECTOR_SCOPES,
                        },
                        signal,
                    );
                    signal.throwIfAborted();
                    set({ grant: { grant, kind: "ready" } });
                } catch (error) {
                    if (!signal.aborted) {
                        set({ grant: { kind: "failed", message: failureMessage(error) } });
                    }
                }
            },
            loadConnections,
            openGrantForm: () =>
                set({
                    copyAnnouncement: "",
                    grant: { kind: "idle" },
                    grantForm: { audience: "mobius-cloud", kind: "editing", label: "" },
                }),
            revokeConnection: async (connection, signal) => {
                set({ busyResourceId: connection.connectionId, operationError: "" });
                try {
                    await client.revokeConnection(botId, connection.connectionId, connection.lifecycleRevision, signal);
                    signal.throwIfAborted();
                    set({ revokeConfirmationId: "" });
                    await loadConnections(signal);
                } catch (error) {
                    if (!signal.aborted) {
                        set({ operationError: failureMessage(error) });
                    }
                } finally {
                    if (!signal.aborted) {
                        set({ busyResourceId: "" });
                    }
                }
            },
            setAudience: (audience) => {
                const form = get().grantForm;
                if (form.kind === "editing") {
                    set({ grantForm: { ...form, audience } });
                }
            },
            setLabel: (label) => {
                const form = get().grantForm;
                if (form.kind === "editing") {
                    set({ grantForm: { ...form, label } });
                }
            },
        };
    });

export function formatConnectionDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function targetsForConnection(directory: MobiusBotConnectionDirectory, connectionId: string) {
    return directory.deliveryTargets.filter((target) => target.connectionId === connectionId);
}
