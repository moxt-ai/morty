import type { ApiTransport } from "../../services/api/api-transport.ts";
import {
    AnonymousIdentityApi,
    IdentityApiError,
    type IdentityTransfer,
    type LinkedDevice,
    type OpenWindowsAfterDisconnect,
} from "../../services/identity/anonymous-identity-api.ts";
import { createRemoteAccessOperations } from "../chat/remote-access-store.ts";

export interface IdentityAccess {
    readonly createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>;
    readonly currentAccessToken: (signal: AbortSignal) => Promise<string>;
    /** Ends the access this browser holds when it runs. */
    readonly endRemoteAccess: (signal: AbortSignal) => Promise<void>;
    readonly linkedDevices: (signal: AbortSignal) => Promise<readonly LinkedDevice[]>;
    /** Resolves once the linked devices differ from the list this page last read. */
    readonly waitForLinkedDevicesChange: (signal: AbortSignal) => Promise<void>;
    /** Disconnects every other browser that joined through a link while this one keeps its access. */
    readonly endOtherBrowserAccess: (signal: AbortSignal) => Promise<OpenWindowsAfterDisconnect>;
}

class IdentitySharingUnavailable extends Error {
    readonly code = "identity_sharing_unavailable";

    constructor() {
        super("Morty cannot be shared from this device.");
        this.name = "IdentitySharingUnavailable";
    }
}

export function createIdentityAccess(options: {
    readonly fetchRequest: (request: Request) => Promise<Response>;
    readonly waitForChange: ApiTransport["waitForChange"];
    readonly origin: string;
    readonly identity: { readonly projectId: string; readonly getToken: (signal: AbortSignal) => Promise<string> };
    readonly onAccessEnded: () => void;
    readonly currentAccess: (
        signal: AbortSignal,
    ) => Promise<{ readonly projectId: string; readonly token: string } | null>;
    readonly credentialRejected: () => Promise<void>;
}): IdentityAccess {
    const api = new AnonymousIdentityApi({ fetchRequest: options.fetchRequest, origin: options.origin });
    const remoteAccess = createRemoteAccessOperations({ ...options, onEnded: options.onAccessEnded });
    /** A refusal of this browser's own access is reported to its owner before the caller sees it. */
    const withCurrentAccess = async <T>(signal: AbortSignal, operation: (token: string) => Promise<T>): Promise<T> => {
        try {
            return await operation(await remoteAccess.currentAccessToken(signal));
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof IdentityApiError && cause.status === 401) {
                await options.credentialRejected();
            }
            throw cause;
        }
    };
    return {
        ...remoteAccess,
        linkedDevices: (signal) => withCurrentAccess(signal, (token) => api.linkedDevices(token, signal)),
        waitForLinkedDevicesChange: async (signal) =>
            await api.waitForLinkedDevicesChange(
                await remoteAccess.currentAccessToken(signal),
                options.waitForChange,
                signal,
            ),
        endOtherBrowserAccess: (signal) =>
            withCurrentAccess(signal, (token) => api.endOtherBrowserAccess(token, signal)),
        createTransfer: async (signal) => {
            const localIdentity = await options.currentAccess(signal);
            signal.throwIfAborted();
            if (localIdentity === null || localIdentity.projectId !== options.identity.projectId) {
                throw new IdentitySharingUnavailable();
            }
            return await api.createTransfer(localIdentity.token, signal);
        },
    };
}
