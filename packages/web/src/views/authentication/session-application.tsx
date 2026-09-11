import { useSession } from "@clerk/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button, createApplicationRouter } from "../../index.ts";
import {
    type AnonymousIdentity,
    AnonymousIdentityApi,
    IdentityApiError,
} from "../../services/identity/anonymous-identity-api.ts";
import { verifySession, waitForClerk } from "../../view-models/authentication/session.ts";
import { AccountActions, App, Page } from "../application/app.tsx";
import { MobiusManagement, userBotConnection } from "../applications/mobius-management.tsx";
import { AnonymousAccountActions } from "./anonymous-account-actions.tsx";
import { type ActiveIdentity, ActiveIdentityProvider } from "./identity-context.tsx";
import { router as authRouter } from "./router.tsx";
import { SetupOnboarding } from "./setup-onboarding.tsx";

type IdentityState =
    | { readonly kind: "loading" }
    | { readonly kind: "onboarding" }
    | { readonly kind: "anonymous"; readonly identity: AnonymousIdentity }
    | { readonly kind: "clerk"; readonly localIdentity: AnonymousIdentity | null; readonly userId: string }
    | { readonly kind: "conflict"; readonly identity: AnonymousIdentity }
    | { readonly kind: "failed" };

type WorkspaceApplicationProps = {
    readonly authorize: (signal: AbortSignal) => Promise<void>;
    readonly userId: string;
} & (
    | {
          readonly activeIdentity: Extract<ActiveIdentity, { readonly kind: "anonymous" }>;
          readonly localIdentity: AnonymousIdentity;
      }
    | {
          readonly activeIdentity: Extract<ActiveIdentity, { readonly kind: "clerk" }>;
          readonly localIdentity: AnonymousIdentity | null;
      }
);

function WorkspaceApplication(props: WorkspaceApplicationProps) {
    const { activeIdentity, authorize, localIdentity, userId } = props;
    const router = useMemo(() => {
        let account: ReactNode;
        if (activeIdentity.kind === "anonymous") {
            if (localIdentity === null) {
                throw new Error("Anonymous identity is unavailable.");
            }
            account = <AnonymousAccountActions token={localIdentity.token} />;
        } else {
            account = (
                <div className="flex items-center gap-3">
                    {localIdentity !== null && <AnonymousAccountActions token={localIdentity.token} signedIn />}
                    <AccountActions />
                </div>
            );
        }
        const Standard = ({ children }: { readonly children: ReactNode }) => (
            <>
                {children}
                <div className="fixed bottom-4 left-4 hidden items-center gap-2 sm:flex">{account}</div>
            </>
        );
        return createApplicationRouter(
            authorize,
            userId,
            MobiusManagement,
            userBotConnection(userId, activeIdentity.getToken),
            { Application: Standard, Standard },
        );
    }, [activeIdentity, authorize, localIdentity, userId]);
    return (
        <ActiveIdentityProvider value={activeIdentity}>
            <App state={{ kind: "signed-in", router }} />
        </ActiveIdentityProvider>
    );
}

function BindingConflict({
    identity,
    onResolved,
    session,
}: {
    readonly identity: AnonymousIdentity;
    readonly onResolved: (action: "discard-local" | "override", userId: string) => void;
    readonly session: NonNullable<ReturnType<typeof useSession>["session"]>;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const operation = useRef<AbortController | null>(null);
    useEffect(() => () => operation.current?.abort(), []);
    const resolve = (action: "discard-local" | "override") => {
        operation.current?.abort();
        const controller = new AbortController();
        operation.current = controller;
        setBusy(true);
        setError("");
        const api = new AnonymousIdentityApi({ origin: window.location.origin, storage: window.localStorage });
        void waitForClerk(() => session.getToken(), controller.signal)
            .then((token) => {
                if (token === null) {
                    throw new Error("Sign-in session is unavailable.");
                }
                return api.bindClerk(token, identity.token, action, controller.signal);
            })
            .then((binding) => {
                if (action === "discard-local") {
                    api.clearLocal();
                }
                onResolved(action, binding.userId);
            })
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    setError(cause instanceof Error ? cause.message : "The identity could not be updated.");
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) {
                    operation.current = null;
                    setBusy(false);
                }
            });
    };
    return (
        <Page>
            <section className="mx-auto max-w-xl rounded-xl border border-border bg-card p-6 shadow-sm">
                <h1 className="text-xl font-semibold">Choose which workspace to keep</h1>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    This account is already connected to another workspace. You can discard this device’s local
                    workspace, or connect the account to this workspace instead.
                </p>
                {error.length > 0 && (
                    <p role="alert" className="mt-4 text-sm text-red-700">
                        {error}
                    </p>
                )}
                <div className="mt-6 flex flex-wrap gap-3">
                    <Button disabled={busy} variant="destructive" onClick={() => resolve("discard-local")}>
                        Discard local workspace
                    </Button>
                    <Button disabled={busy} onClick={() => resolve("override")}>
                        Use this workspace instead
                    </Button>
                    <Button disabled={busy} variant="ghost" onClick={() => void session.end()}>
                        Sign out
                    </Button>
                </div>
            </section>
        </Page>
    );
}

export function SessionApplication() {
    const { isLoaded, session } = useSession();
    const [state, setState] = useState<IdentityState>({ kind: "loading" });
    const activeSession = useRef(session);
    activeSession.current = session;
    const authenticationPath = ["/login", "/register", "/sso-callback", "/continue"].some((path) =>
        window.location.pathname.startsWith(path),
    );
    useEffect(() => {
        if (!isLoaded || authenticationPath) {
            return;
        }
        const controller = new AbortController();
        const api = new AnonymousIdentityApi({ origin: window.location.origin, storage: window.localStorage });
        void api
            .loadExisting(controller.signal)
            .then(async (existing) => {
                controller.signal.throwIfAborted();
                if (existing === null && (session === null || session === undefined)) {
                    setState({ kind: "onboarding" });
                    return;
                }
                const identity = existing ?? (await api.loadOrCreate(controller.signal));
                if (session === null || session === undefined) {
                    setState({ identity, kind: "anonymous" });
                    return;
                }
                const clerkToken = await waitForClerk(() => session.getToken(), controller.signal);
                if (clerkToken === null) {
                    throw new Error("Sign-in session is unavailable.");
                }
                const binding = await api.clerkBinding(clerkToken, controller.signal);
                if (binding.kind === "bound") {
                    setState(
                        binding.userId === identity.userId
                            ? { kind: "clerk", localIdentity: identity, userId: binding.userId }
                            : { identity, kind: "conflict" },
                    );
                    return;
                }
                try {
                    const created = await api.bindClerk(clerkToken, identity.token, "bind", controller.signal);
                    setState({ kind: "clerk", localIdentity: identity, userId: created.userId });
                } catch (cause) {
                    if (cause instanceof IdentityApiError && cause.code === "BINDING_CONFLICT") {
                        setState({ identity, kind: "conflict" });
                        return;
                    }
                    throw cause;
                }
            })
            .catch(() => {
                if (!controller.signal.aborted) {
                    setState({ kind: "failed" });
                }
            });
        return () => controller.abort();
    }, [authenticationPath, isLoaded, session]);
    if (!isLoaded) {
        return <App state={{ kind: "loading" }} />;
    }
    if (authenticationPath) {
        return <App state={{ kind: "authentication", router: authRouter }} />;
    }
    if (state.kind === "loading") {
        return <App state={{ kind: "loading" }} />;
    }
    if (state.kind === "onboarding") {
        return <SetupOnboarding />;
    }
    if (state.kind === "failed") {
        return <App state={{ kind: "failed" }} />;
    }
    if (state.kind === "conflict") {
        if (session === null || session === undefined) {
            return <App state={{ kind: "failed" }} />;
        }
        return (
            <BindingConflict
                identity={state.identity}
                session={session}
                onResolved={(action, userId) =>
                    setState({
                        kind: "clerk",
                        localIdentity: action === "discard-local" ? null : state.identity,
                        userId,
                    })
                }
            />
        );
    }
    if (state.kind === "anonymous") {
        const api = new AnonymousIdentityApi({ origin: window.location.origin, storage: window.localStorage });
        const activeIdentity: ActiveIdentity = {
            getToken: async (signal) => {
                signal.throwIfAborted();
                return state.identity.token;
            },
            kind: "anonymous",
        };
        return (
            <WorkspaceApplication
                activeIdentity={activeIdentity}
                localIdentity={state.identity}
                userId={state.identity.userId}
                authorize={async (signal) => {
                    const current = await api.loadOrCreate(signal);
                    if (current.userId !== state.identity.userId) {
                        throw new Error("Anonymous identity changed.");
                    }
                }}
            />
        );
    }
    if (session === null || session === undefined) {
        return <App state={{ kind: "failed" }} />;
    }
    const expectedSessionId = session.id;
    const activeIdentity: ActiveIdentity = {
        kind: "clerk",
        getToken: (signal) => waitForClerk(() => activeSession.current?.getToken() ?? Promise.resolve(null), signal),
    };
    return (
        <WorkspaceApplication
            activeIdentity={activeIdentity}
            localIdentity={state.localIdentity}
            userId={state.userId}
            authorize={(signal) =>
                verifySession(
                    expectedSessionId,
                    activeSession.current?.id,
                    () => activeSession.current?.getToken() ?? Promise.resolve(null),
                    signal,
                )
            }
        />
    );
}
