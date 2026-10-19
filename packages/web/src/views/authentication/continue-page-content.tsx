import { LoaderCircle } from "lucide-react";
import { Button, Spinner } from "../../index.ts";
import type { ContinueState } from "../../view-models/authentication/continue-store.ts";
import { Page } from "../application/app.tsx";
import {
    setupDetailsListClassName,
    setupPrimaryButtonClassName,
    setupSecondaryTextClassName,
} from "../setup/setup-card-shell.tsx";

export function ContinuePageContent({ retry, state }: { readonly retry: () => void; readonly state: ContinueState }) {
    const sessionFlow = state.kind === "session-opening" || state.kind === "session-failed";

    return (
        <Page>
            <div className="mx-auto flex w-full max-w-xl items-start justify-center">
                <section className="min-w-0 max-w-xl flex-1 rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
                    <h1 className="max-w-md text-32 font-semibold tracking-[-0.035em]">
                        {sessionFlow ? "Continue native session" : "Continue in Morty"}
                    </h1>
                    {state.kind === "session-opening" ? (
                        <>
                            <p className={`mt-2 max-w-xl ${setupSecondaryTextClassName}`}>
                                Opening the original session in Morty.
                            </p>
                            <div className="mt-6 flex items-center gap-3">
                                <Spinner label="Opening session" />
                                <span className="text-sm text-muted-foreground">Opening session…</span>
                            </div>
                            <dl className={`mt-6 ${setupDetailsListClassName}`}>
                                <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
                                    <dt className="text-muted-foreground">Agent</dt>
                                    <dd className="truncate font-medium">{state.handoff.harness}</dd>
                                </div>
                                <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-3">
                                    <dt className="text-muted-foreground">Session ID</dt>
                                    <dd className="break-all font-mono text-xs leading-5">{state.handoff.sessionId}</dd>
                                </div>
                            </dl>
                        </>
                    ) : state.kind === "session-failed" ? (
                        <>
                            <p className={`mt-2 max-w-xl ${setupSecondaryTextClassName}`}>
                                This native session could not be opened in Morty.
                            </p>
                            <dl className={`mt-6 ${setupDetailsListClassName}`}>
                                <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
                                    <dt className="text-muted-foreground">Agent</dt>
                                    <dd className="truncate font-medium">{state.handoff.harness}</dd>
                                </div>
                                <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-3">
                                    <dt className="text-muted-foreground">Session ID</dt>
                                    <dd className="break-all font-mono text-xs leading-5">{state.handoff.sessionId}</dd>
                                </div>
                            </dl>
                            <p role="alert" className="mt-4 text-16 leading-[26px] text-destructive">
                                {state.message}
                            </p>
                            <div className="mt-6 flex flex-wrap items-center gap-3">
                                <Button className={setupPrimaryButtonClassName} onClick={retry}>
                                    Try again
                                </Button>
                                <Button asChild variant="ghost" className="px-0">
                                    <a href="/">Return to Morty</a>
                                </Button>
                            </div>
                        </>
                    ) : state.kind === "identity-redeeming" ? (
                        <p
                            role="status"
                            aria-label="Securely transferring Morty access"
                            className="mt-2 flex max-w-xl items-start gap-2 text-16 leading-[26px] text-muted-foreground"
                        >
                            <LoaderCircle
                                aria-hidden="true"
                                className="mt-1 size-4 shrink-0 animate-spin text-primary"
                            />
                            <span>
                                Securely transferring access from your agent. Keep the Runtime online on your computer.
                            </span>
                        </p>
                    ) : (
                        <>
                            <p role="alert" className="mt-2 max-w-xl text-16 leading-[26px] text-destructive">
                                {state.kind === "failed"
                                    ? state.message
                                    : "This transfer link is invalid or has expired."}
                            </p>
                            <Button asChild className={`mt-6 ${setupPrimaryButtonClassName}`} variant="outline">
                                <a href="/">Return to Morty</a>
                            </Button>
                        </>
                    )}
                </section>
            </div>
        </Page>
    );
}
