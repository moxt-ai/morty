import { type ReactNode, useMemo } from "react";
import { useStore } from "zustand";
import { createApplicationRouter } from "../../index.ts";
import type { MortyApplication } from "../../view-models/morty-application.ts";
import { App } from "../application/app.tsx";
import { MobiusManagement } from "../applications/mobius-management.tsx";
import { PairingInstruction } from "../chat/pairing-instruction.tsx";
import { type ActiveIdentity, ActiveIdentityProvider } from "./identity-context.tsx";
import { router as continuationRouter } from "./router.tsx";

export function SignedInApplication(props: {
    readonly activeIdentity: ActiveIdentity;
    readonly authorize: (signal: AbortSignal) => Promise<void>;
}) {
    const { activeIdentity, authorize } = props;
    const router = useMemo(() => {
        const Standard = ({ children }: { readonly children: ReactNode }) => <>{children}</>;
        return createApplicationRouter(authorize, MobiusManagement, { Application: Standard, Standard });
    }, [authorize]);
    return (
        <ActiveIdentityProvider value={activeIdentity}>
            <App state={{ kind: "signed-in", router }} />
        </ActiveIdentityProvider>
    );
}

export function SessionApplication({ application }: { readonly application: MortyApplication }) {
    const { authorize, state } = useStore(application.anonymousSession);
    const continuationPath = window.location.pathname.startsWith("/continue");
    if (continuationPath) {
        return <App state={{ kind: "authentication", router: continuationRouter }} />;
    }
    if (state.kind === "loading") {
        return <App state={{ kind: "loading" }} />;
    }
    if (state.kind === "failed") {
        return <App state={{ kind: "failed" }} />;
    }
    if (state.kind === "setup") {
        return <SetupApplication accessEnded={state.notice === "access-ended"} />;
    }
    const activeIdentity: ActiveIdentity = {
        botId: state.identity.botId,
        getToken: async (signal) => {
            signal.throwIfAborted();
            return state.identity.token;
        },
        projectId: state.identity.projectId,
    };
    return <SignedInApplication activeIdentity={activeIdentity} authorize={authorize} />;
}

function SetupApplication({ accessEnded }: { readonly accessEnded: boolean }) {
    return (
        <main className="flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,_hsl(var(--muted))_0%,_hsl(var(--background))_48%)] px-6 py-12 text-foreground">
            <section aria-labelledby="setup-title" className="w-full max-w-2xl">
                {accessEnded && (
                    <div
                        role="status"
                        className="mb-5 rounded-xl border border-primary/20 bg-primary/5 px-5 py-4 text-sm"
                    >
                        <p className="font-medium">Current access ended</p>
                        <p className="mt-1 text-muted-foreground">Your local agent and tasks keep running.</p>
                    </div>
                )}
                <div className="rounded-3xl border border-border/70 bg-card/90 p-8 shadow-2xl shadow-black/10 backdrop-blur sm:p-12">
                    <div className="mb-10 flex size-12 items-center justify-center rounded-2xl bg-primary text-xl font-bold text-primary-foreground shadow-lg shadow-primary/20">
                        M
                    </div>
                    <p className="text-sm font-medium text-primary">Welcome to Morty</p>
                    <h1 id="setup-title" className="mt-2 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
                        Connect your local agent
                    </h1>
                    <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">
                        Copy this instruction into your agent. It will connect itself and finish the setup for you.
                    </p>
                    <PairingInstruction />
                </div>
            </section>
        </main>
    );
}
