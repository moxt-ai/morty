import { createStore } from "zustand/vanilla";
import type { RemoteImageConsentModel } from "../../components/agents/remote-image-consent.tsx";

/** The page keeps the user's answer, so an image they asked for stays shown wherever its message appears again. */
export function createRemoteImageConsentStore() {
    return createStore<RemoteImageConsentModel>()((set, get) => ({
        shown: new Set(),
        show: (href) => {
            if (!get().shown.has(href)) {
                set({ shown: new Set([...get().shown, href]) });
            }
        },
    }));
}
