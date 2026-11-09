import type { SessionWireEnvelope } from "@morty-build/client/protocol";

export interface SessionStatusNotifications {
    readonly publish: (
        scope: { readonly computerId: string; readonly pairingId: string },
        envelope: SessionWireEnvelope,
    ) => void;
}
