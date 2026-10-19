import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { Dialog } from "../../components/ui/dialog.tsx";
import { createApplicationRouter } from "../../index.ts";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import { createAnonymousSessionStore } from "../../view-models/authentication/anonymous-session-store.ts";
import { App } from "../application/app.tsx";
import { MobiusManagement } from "../applications/mobius-management.tsx";
import { PairingInstruction } from "../chat/pairing-instruction.tsx";
import { type ActiveIdentity, ActiveIdentityProvider } from "./identity-context.tsx";
import { router as continuationRouter } from "./router.tsx";

export function MortyApplication(props: {
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

export function SessionApplication() {
    const transport = useApiTransport();
    const [store] = useState(() => createAnonymousSessionStore(transport.fetch, window.location.origin));
    const { authorize, load, state } = useStore(store);
    const continuationPath = window.location.pathname.startsWith("/continue");
    useEffect(() => {
        if (continuationPath) {
            return;
        }
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [continuationPath, load]);
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
    return <MortyApplication activeIdentity={activeIdentity} authorize={authorize} />;
}

function SetupApplication() {
    const [open, setOpen] = useState(true);
    return (
        <main className="fixed inset-0 flex min-h-0 overflow-hidden bg-background text-foreground" aria-label="Chat">
            <div className="m-auto max-w-lg px-6 text-center">
                <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.025em]">Morty</h1>
            </div>
            {open && (
                <Dialog
                    title="Connect agent"
                    description="Morty is ready. Paste this instruction into your local agent to connect it."
                    onClose={() => setOpen(false)}
                >
                    <PairingInstruction />
                </Dialog>
            )}
        </main>
    );
}
