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
        return <SetupApplication />;
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

function SetupApplication() {
    return (
        <main className="flex min-h-screen items-center justify-center overflow-y-auto bg-[radial-gradient(circle_at_top,_hsl(var(--muted))_0%,_hsl(var(--background))_48%)] px-6 py-12 text-foreground">
            <section aria-labelledby="setup-title" className="w-full max-w-2xl">
                <div className="rounded-3xl border border-border/70 bg-card/90 p-8 shadow-2xl shadow-black/10 backdrop-blur sm:p-12">
                    <div className="mb-10 flex size-12 items-center justify-center rounded-2xl bg-primary text-xl font-bold text-primary-foreground shadow-lg shadow-primary/20">
                        M
                    </div>
                    <p className="text-sm font-medium text-primary">Morty</p>
                    <h1
                        id="setup-title"
                        className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-balance sm:text-4xl"
                    >
                        Continue your coding session from your phone.
                    </h1>
                    <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">
                        Check progress, send instructions, and approve requests while your agent runs on your computer.
                    </p>
                    <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                        Works with Codex, Claude Code, and Pi.
                    </p>
                    <h2 className="mt-10 text-lg font-semibold tracking-tight">Start on your computer</h2>
                    <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                        Paste the instruction below into the coding agent session you want to continue. Then open the
                        link it returns on your phone or in another browser.
                    </p>
                    <div className="mt-4">
                        <PairingInstruction />
                    </div>
                    <p className="mt-4 text-sm text-muted-foreground">Local execution. Remote access you can revoke.</p>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                        Keep your computer awake and online. Setup may install or update the local connection software.
                    </p>
                </div>
            </section>
        </main>
    );
}
