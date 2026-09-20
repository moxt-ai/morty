export interface MobiusChatDebugSession {
    readonly sessionId: string;
    readonly blocks: () => readonly unknown[];
}

interface MobiusChatDebugBridge {
    readonly currentSession: () => MobiusChatDebugSession | null;
}

declare global {
    var _mobiusChat: MobiusChatDebugBridge;
}

let currentSession: MobiusChatDebugSession | null = null;

const bridge: MobiusChatDebugBridge = Object.freeze({
    currentSession: () => currentSession,
});

export function installMobiusChatDebugBridge(): void {
    globalThis._mobiusChat = bridge;
}

export function registerMobiusChatDebugSession(session: MobiusChatDebugSession): () => void {
    const registered = Object.freeze(session);
    currentSession = registered;
    return () => {
        if (currentSession === registered) {
            currentSession = null;
        }
    };
}
