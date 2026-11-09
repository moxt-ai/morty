import type { NativeSessionTarget } from "@morty-build/client/protocol";

export interface MortyDebugSession {
    readonly target: NativeSessionTarget;
    readonly blocks: () => readonly unknown[];
}

interface MortyDebugBridge {
    readonly currentSession: () => MortyDebugSession | null;
}

declare global {
    var _morty: MortyDebugBridge;
}

let currentSession: MortyDebugSession | null = null;

const bridge: MortyDebugBridge = Object.freeze({
    currentSession: () => currentSession,
});

export function installMortyDebugBridge(): void {
    globalThis._morty = bridge;
}

export function registerMortyDebugSession(session: MortyDebugSession): () => void {
    const registered = Object.freeze(session);
    currentSession = registered;
    return () => {
        if (currentSession === registered) {
            currentSession = null;
        }
    };
}
