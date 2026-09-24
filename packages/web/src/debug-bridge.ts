declare global {
    var _morty: { readonly currentSession: () => null };
}

export function installMortyDebugBridge(): void {
    globalThis._morty = { currentSession: () => null };
}
