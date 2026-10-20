import { createContext, type ReactNode, useContext } from "react";
import type { MortyApplication } from "../../view-models/morty-application.ts";

const MortyApplicationContext = createContext<MortyApplication | null>(null);

export function MortyApplicationProvider({
    application,
    children,
}: {
    readonly application: MortyApplication;
    readonly children: ReactNode;
}) {
    return <MortyApplicationContext.Provider value={application}>{children}</MortyApplicationContext.Provider>;
}

export function useMortyApplication(): MortyApplication {
    const application = useContext(MortyApplicationContext);
    if (application === null) {
        throw new Error("The Morty application is unavailable.");
    }
    return application;
}
