import { createStore } from "zustand/vanilla";
import {
    createChannelAccessGrant,
    readLinkedChannelDevices,
    revokeLinkedChannelDevice,
} from "@/services/pairing/pairing-api";
import type { CreatedChannelAccessGrant, LinkedChannelDevice } from "@/view-models/chat/channel";
import { PairingApiError } from "@/view-models/chat/channel";

type DeviceDirectoryState =
    | { readonly kind: "loading" }
    | { readonly kind: "owner"; readonly devices: readonly LinkedChannelDevice[] }
    | { readonly kind: "linked-device" }
    | { readonly kind: "failed"; readonly message: string };
type AccessLinkState =
    | { readonly kind: "idle" }
    | { readonly kind: "creating" }
    | { readonly kind: "ready"; readonly expiresAt: Date; readonly url: string }
    | { readonly kind: "failed"; readonly message: string };
type DeviceRevocationState =
    | { readonly kind: "idle" }
    | { readonly kind: "revoking"; readonly credentialId: string }
    | { readonly kind: "failed"; readonly message: string };

export interface ChannelAccessStore {
    readonly copyConfirmation: string;
    readonly directory: DeviceDirectoryState;
    readonly link: AccessLinkState;
    readonly revocation: DeviceRevocationState;
    readonly copyLink: () => Promise<void>;
    readonly createLink: (signal: AbortSignal) => Promise<void>;
    readonly loadDevices: (signal: AbortSignal) => Promise<void>;
    readonly revokeDevice: (credentialId: string, signal: AbortSignal) => Promise<void>;
}

function accessFailure(error: unknown): string {
    return error instanceof PairingApiError
        ? `${error.code}: ${error.message}`
        : "The access request failed unexpectedly.";
}

function buildAccessLink(channelId: string, grant: CreatedChannelAccessGrant): string {
    const url = new URL(`/channels/${encodeURIComponent(channelId)}`, window.location.origin);
    const fragment = new URLSearchParams();
    fragment.set("access", `${grant.grantId}.${grant.grantSecret}`);
    url.hash = fragment.toString();
    return url.href;
}

export const createChannelAccessStore = (channelId: string) =>
    createStore<ChannelAccessStore>()((set, get) => ({
        copyConfirmation: "",
        directory: { kind: "loading" },
        link: { kind: "idle" },
        revocation: { kind: "idle" },
        copyLink: async () => {
            const link = get().link;
            if (link.kind !== "ready") {
                return;
            }
            try {
                await navigator.clipboard.writeText(link.url);
                set({ copyConfirmation: "Access link copied." });
            } catch {
                set({ copyConfirmation: "Copy was unavailable. Select the full link and copy it manually." });
            }
        },
        createLink: async (signal) => {
            set({ copyConfirmation: "", link: { kind: "creating" } });
            try {
                const grant = await createChannelAccessGrant(channelId, signal);
                signal.throwIfAborted();
                set({ link: { expiresAt: grant.expiresAt, kind: "ready", url: buildAccessLink(channelId, grant) } });
            } catch (error) {
                if (!signal.aborted) {
                    set({ link: { kind: "failed", message: accessFailure(error) } });
                }
            }
        },
        loadDevices: async (signal) => {
            set({ directory: { kind: "loading" } });
            try {
                const devices = await readLinkedChannelDevices(channelId, signal);
                signal.throwIfAborted();
                set({ directory: { devices, kind: "owner" } });
            } catch (error) {
                if (signal.aborted) {
                    return;
                }
                set({
                    directory:
                        error instanceof PairingApiError && error.code === "owner_access_required"
                            ? { kind: "linked-device" }
                            : { kind: "failed", message: accessFailure(error) },
                });
            }
        },
        revokeDevice: async (credentialId, signal) => {
            const directory = get().directory;
            if (directory.kind !== "owner") {
                return;
            }
            set({ revocation: { credentialId, kind: "revoking" } });
            try {
                await revokeLinkedChannelDevice(channelId, credentialId, signal);
                signal.throwIfAborted();
                set({
                    directory: {
                        devices: directory.devices.filter((device) => device.credentialId !== credentialId),
                        kind: "owner",
                    },
                    revocation: { kind: "idle" },
                });
            } catch (error) {
                if (!signal.aborted) {
                    set({ revocation: { kind: "failed", message: accessFailure(error) } });
                }
            }
        },
    }));

export function formatAccessDate(date: Date): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function linkedDeviceLabel(device: LinkedChannelDevice): string {
    return `Linked device ${device.credentialId.slice(-6)}`;
}
