import type { SessionWireEnvelope } from "@morty-build/client/protocol";

export interface SessionStatusNotifications {
    readonly publish: (
        scope: { readonly accountId: string; readonly runtimeId: string },
        envelope: SessionWireEnvelope,
    ) => void;
}
