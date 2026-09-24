export interface MortyDebugSession {
    readonly sessionId: string;
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
