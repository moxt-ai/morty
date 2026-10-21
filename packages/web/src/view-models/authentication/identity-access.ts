import { AnonymousIdentityApi, type IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import { createRemoteAccessOperations } from "../chat/remote-access-store.ts";

export interface IdentityAccess {
    readonly createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>;
    readonly currentAccessToken: (signal: AbortSignal) => Promise<string>;
    readonly endRemoteAccess: (token: string, signal: AbortSignal) => Promise<void>;
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
    readonly origin: string;
    readonly identity: { readonly projectId: string; readonly getToken: (signal: AbortSignal) => Promise<string> };
    readonly onAccessEnded: () => void;
}): IdentityAccess {
    const api = new AnonymousIdentityApi({ fetchRequest: options.fetchRequest, origin: options.origin });
    return {
        ...createRemoteAccessOperations({ ...options, onEnded: options.onAccessEnded }),
        createTransfer: async (signal) => {
            const localIdentity = await api.loadExisting(signal);
            signal.throwIfAborted();
            if (localIdentity === null || localIdentity.projectId !== options.identity.projectId) {
                throw new IdentitySharingUnavailable();
            }
            return await api.createTransfer(localIdentity.token, signal);
        },
    };
}
