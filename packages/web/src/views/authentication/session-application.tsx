import { type ReactNode, useMemo } from "react";
import { useStore } from "zustand";
import { createApplicationRouter } from "../../index.ts";
import type { MortyApplication } from "../../view-models/morty-application.ts";
import { App } from "../application/app.tsx";
import { MobiusManagement } from "../applications/mobius-management.tsx";
import { chatPreviewRouter } from "../chat/chat-preview-router.tsx";
import { PairingInstruction } from "../chat/pairing-instruction.tsx";
import { SetupCardDescription, SetupCardShell, SetupCardTitle } from "../setup/setup-card-shell.tsx";
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
    const chatPreviewPath = window.location.pathname.startsWith("/chat/preview");
    if (chatPreviewPath) {
        return <App state={{ kind: "authentication", router: chatPreviewRouter }} />;
    }
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
    if (state.kind === "choices") {
        return (
            <SetupCardShell titleId="saved-access-title">
                <SetupCardTitle id="saved-access-title">Continue with saved access</SetupCardTitle>
                <SetupCardDescription>
                    This browser has access to more than one Morty identity. Choose where to continue.
                </SetupCardDescription>
                <ul className="mt-6 space-y-3">
                    {state.choices.map((choice) => (
                        <li key={choice.href}>
                            <a
                                className="block rounded-xl border border-border px-5 py-4 font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
                                href={choice.href}
                            >
                                Continue to {choice.label}
                            </a>
                        </li>
                    ))}
                </ul>
                <a className="mt-6 inline-block text-sm text-primary underline" href="/setup">
                    Set up another computer
                </a>
            </SetupCardShell>
        );
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
        <SetupCardShell titleId="setup-title">
            {accessEnded && (
                <div role="status" className="mb-5 rounded-xl border border-primary/20 bg-primary/5 px-5 py-4 text-sm">
                    <p className="font-medium">Current access ended</p>
                    <p className="mt-1 text-muted-foreground">Your local agent and tasks keep running.</p>
                </div>
            )}
            {window.location.pathname === "/setup" && (
                <a className="mb-5 inline-block text-sm text-primary underline" href="/">
                    Continue with saved access
                </a>
            )}
            <p className="text-sm font-medium text-primary">Morty</p>
            <SetupCardTitle id="setup-title">Continue your coding session from your phone.</SetupCardTitle>
            <SetupCardDescription>
                Check progress, send instructions, and approve requests while your agent runs on your computer.
            </SetupCardDescription>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">Works with Codex, Claude Code, and Pi.</p>
            <h2 className="mt-10 text-lg font-semibold tracking-tight">Start on your computer</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                Paste the instruction below into the coding agent session you want to continue. Then open the link it
                returns on your phone or in another browser.
            </p>
            <div className="mt-4">
                <PairingInstruction />
            </div>
            <p className="mt-4 text-sm text-muted-foreground">Local execution. Remote access you can revoke.</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Keep your computer awake and online. Setup may install or update the local connection software.
            </p>
        </SetupCardShell>
    );
}
