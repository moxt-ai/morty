import { createContext, type ReactNode, useContext } from "react";
import type { MortyApplication } from "../../view-models/morty-application.ts";

const MortyApplicationContext = createContext<MortyApplication | null>(null);

/**
 * The one application provider: the application root (transport, sessions,
 * workspaces, dialog stores) reaches views through this context. Stores that
 * flow through a prop chain (the chat workspace tree) are injected as props;
 * this context carries only the application-scoped root itself.
 */
export function MortyApplicationProvider({
    application,
    children,
}: {
    readonly application: MortyApplication;
    readonly children: ReactNode;
}) {
    return <MortyApplicationContext value={application}>{children}</MortyApplicationContext>;
}

export function useMortyApplication(): MortyApplication {
    const application = useContext(MortyApplicationContext);
    if (application === null) {
        throw new Error("The Morty application is unavailable.");
    }
    return application;
}
