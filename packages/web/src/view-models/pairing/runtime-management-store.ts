import {
    MobiusExpiredRuntimePairingStatus,
    MobiusPairedRuntimePairingStatus,
    MobiusPendingRuntimePairingStatus,
    MobiusRevokedRuntimePairingStatus,
    type MobiusRuntimeDescriptor,
    type MobiusRuntimePairing,
} from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import {
    createProjectRuntimePairing,
    OwnerRuntimeManagementAccess,
    readProjectRuntimePairing,
    readProjectRuntimes,
    readRuntimeManagementAccess,
    revokeProjectRuntime,
} from "@/services/pairing/pairing-api";
import { PairingApiError } from "@/view-models/chat/channel";

export type RuntimeDirectoryState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly canManage: boolean; readonly runtimes: readonly MobiusRuntimeDescriptor[] }
    | { readonly kind: "failed"; readonly message: string };

type RuntimePairingState =
    | { readonly kind: "idle" }
    | { readonly kind: "creating"; readonly idempotencyKey: string }
    | { readonly kind: "pending"; readonly pairing: MobiusRuntimePairing }
    | { readonly kind: "checking"; readonly pairing: MobiusRuntimePairing }
    | { readonly kind: "connected"; readonly machineName: string }
    | { readonly kind: "claimed"; readonly machineName: string; readonly pairing: MobiusRuntimePairing }
    | { readonly kind: "expired" }
    | { readonly kind: "revoked" }
    | { readonly kind: "creation-failed"; readonly idempotencyKey: string; readonly message: string }
    | { readonly kind: "check-failed"; readonly message: string; readonly pairing: MobiusRuntimePairing };

export type RuntimeRevocationState =
    | { readonly kind: "idle" }
    | { readonly kind: "confirming"; readonly runtimeId: string }
    | { readonly kind: "revoking"; readonly runtimeId: string }
    | { readonly kind: "failed"; readonly message: string; readonly runtimeId: string };

export interface RuntimeManagementStore {
    readonly announcement: string;
    readonly copyConfirmation: string;
    readonly directory: RuntimeDirectoryState;
    readonly pairing: RuntimePairingState;
    readonly revocation: RuntimeRevocationState;
    readonly cancelRevocation: () => void;
    readonly checkPairing: (pairing: MobiusRuntimePairing, signal: AbortSignal) => Promise<void>;
    readonly copyValue: (value: string, successMessage: string) => Promise<void>;
    readonly loadDirectory: (signal: AbortSignal) => Promise<void>;
    readonly requestPairing: (idempotencyKey: string, signal: AbortSignal) => Promise<void>;
    readonly requestRevocation: (runtimeId: string) => void;
    readonly revokeRuntime: (runtime: MobiusRuntimeDescriptor, signal: AbortSignal) => Promise<void>;
    readonly startPairing: (signal: AbortSignal) => Promise<void>;
}

function failureMessage(error: unknown): string {
    return error instanceof PairingApiError
        ? `${error.code}: ${error.message}`
        : "The Runtime management request failed unexpectedly.";
}

async function readDirectory(
    channelId: string,
    projectId: string,
    signal: AbortSignal,
): Promise<Extract<RuntimeDirectoryState, { readonly kind: "ready" }>> {
    const [runtimes, access] = await Promise.all([
        readProjectRuntimes(channelId, projectId, signal),
        readRuntimeManagementAccess(channelId, projectId, signal),
    ]);
    signal.throwIfAborted();
    return { canManage: access instanceof OwnerRuntimeManagementAccess, kind: "ready", runtimes };
}

export const createRuntimeManagementStore = (channelId: string, projectId: string) =>
    createStore<RuntimeManagementStore>()((set, get) => ({
        announcement: "",
        copyConfirmation: "",
        directory: { kind: "loading" },
        pairing: { kind: "idle" },
        revocation: { kind: "idle" },
        cancelRevocation: () => set({ revocation: { kind: "idle" } }),
        checkPairing: async (pairing, signal) => {
            set({ announcement: "", pairing: { kind: "checking", pairing } });
            try {
                const status = await readProjectRuntimePairing(channelId, projectId, pairing.pairingId, signal);
                signal.throwIfAborted();
                if (status instanceof MobiusPendingRuntimePairingStatus) {
                    set({
                        announcement: "The other machine has not claimed this code yet.",
                        pairing: { kind: "pending", pairing },
                    });
                    return;
                }
                if (status instanceof MobiusPairedRuntimePairingStatus) {
                    const directory = await readDirectory(channelId, projectId, signal);
                    const connected = directory.runtimes.find((runtime) => runtime.runtimeId === status.runtimeId);
                    if (connected === undefined) {
                        set({
                            directory,
                            pairing: {
                                kind: "check-failed",
                                message: "The paired Runtime is missing from the workspace directory.",
                                pairing,
                            },
                        });
                        return;
                    }
                    set({
                        directory,
                        pairing: connected.online
                            ? { kind: "connected", machineName: status.machineName }
                            : { kind: "claimed", machineName: status.machineName, pairing },
                    });
                    return;
                }
                if (status instanceof MobiusExpiredRuntimePairingStatus) {
                    set({ pairing: { kind: "expired" } });
                    return;
                }
                if (status instanceof MobiusRevokedRuntimePairingStatus) {
                    set({ pairing: { kind: "revoked" } });
                    return;
                }
                set({
                    pairing: {
                        kind: "check-failed",
                        message: "The Relay returned an unsupported Runtime pairing state.",
                        pairing,
                    },
                });
            } catch (error) {
                if (!signal.aborted) {
                    set({ pairing: { kind: "check-failed", message: failureMessage(error), pairing } });
                }
            }
        },
        copyValue: async (value, successMessage) => {
            try {
                await navigator.clipboard.writeText(value);
                set({ copyConfirmation: successMessage });
            } catch {
                set({ copyConfirmation: "Copy was unavailable. Select the value and copy it manually." });
            }
        },
        loadDirectory: async (signal) => {
            set({ directory: { kind: "loading" } });
            try {
                set({ directory: await readDirectory(channelId, projectId, signal) });
            } catch (error) {
                if (!signal.aborted) {
                    set({ directory: { kind: "failed", message: failureMessage(error) } });
                }
            }
        },
        requestPairing: async (idempotencyKey, signal) => {
            set({
                announcement: "",
                copyConfirmation: "",
                pairing: { idempotencyKey, kind: "creating" },
            });
            try {
                const pairing = await createProjectRuntimePairing(channelId, projectId, idempotencyKey, signal);
                signal.throwIfAborted();
                set({ pairing: { kind: "pending", pairing } });
            } catch (error) {
                if (!signal.aborted) {
                    set({ pairing: { idempotencyKey, kind: "creation-failed", message: failureMessage(error) } });
                }
            }
        },
        requestRevocation: (runtimeId) => set({ revocation: { kind: "confirming", runtimeId } }),
        revokeRuntime: async (runtime, signal) => {
            set({ announcement: "", revocation: { kind: "revoking", runtimeId: runtime.runtimeId } });
            try {
                await revokeProjectRuntime(channelId, projectId, runtime.runtimeId, signal);
                signal.throwIfAborted();
                const directory = get().directory;
                set({
                    announcement: `${runtimeDisplayName(runtime)} was revoked.`,
                    directory:
                        directory.kind === "ready" && directory.canManage
                            ? {
                                  ...directory,
                                  runtimes: directory.runtimes.filter(
                                      (candidate) => candidate.runtimeId !== runtime.runtimeId,
                                  ),
                              }
                            : directory,
                    revocation: { kind: "idle" },
                });
            } catch (error) {
                if (!signal.aborted) {
                    set({
                        revocation: { kind: "failed", message: failureMessage(error), runtimeId: runtime.runtimeId },
                    });
                }
            }
        },
        startPairing: async (signal) => {
            await get().requestPairing(`web-${crypto.randomUUID()}`, signal);
        },
    }));

export function formatRuntimeDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function runtimeDisplayName(runtime: MobiusRuntimeDescriptor): string {
    return runtime.machineName.trim().length > 0 ? runtime.machineName : `Runtime ${runtime.runtimeId.slice(-6)}`;
}

export function runtimePairingCommand(pairing: MobiusRuntimePairing): string {
    return `npx --yes @moxt-ai/mobius pair --url ${JSON.stringify(window.location.origin)} --code ${pairing.pairingCode}`;
}
