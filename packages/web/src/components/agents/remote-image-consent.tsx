import { createContext, type ReactNode } from "react";
import type { StoreApi } from "zustand/vanilla";

/**
 * The images on other sites the user asked this page to load. Declared here so components stay decoupled from the
 * view-model layer that owns it.
 */
export interface RemoteImageConsentModel {
    readonly shown: ReadonlySet<string>;
    readonly show: (href: string) => void;
}

export const RemoteImageConsent = createContext<StoreApi<RemoteImageConsentModel> | null>(null);

export function RemoteImageConsentProvider({
    store,
    children,
}: {
    readonly store: StoreApi<RemoteImageConsentModel>;
    readonly children: ReactNode;
}) {
    return <RemoteImageConsent value={store}>{children}</RemoteImageConsent>;
}
