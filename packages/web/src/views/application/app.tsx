import { type AnyRouter, RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button, Spinner } from "../../index.ts";
import type { BugReportDialogStore } from "../../view-models/bug-report-dialog-store.ts";
import { PairingInstruction } from "../chat/pairing-instruction.tsx";
import { BugReportButton, BugReportDialogHost } from "../diagnostics/bug-report-button.tsx";
import {
    SetupCardDescription,
    SetupCardFailureIcon,
    SetupCardSection,
    SetupCardShell,
    SetupCardTitle,
    setupPrimaryButtonClassName,
    setupPrimaryButtonSize,
} from "../setup/setup-card-shell.tsx";

export type AppState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly retry: () => void }
    | { readonly kind: "invalid-link"; readonly continueHref: string | null }
    | {
          readonly kind: "setup";
          readonly notice: "access-ended" | "legacy" | "none";
          readonly returnHref: string | null;
      }
    | { readonly kind: "authentication"; readonly router: AnyRouter }
    | {
          readonly kind: "signed-in";
          readonly router: AnyRouter;
      };

function AppHeader({ account, navigation }: { readonly account?: ReactNode; readonly navigation?: ReactNode }) {
    return (
        <header className="shrink-0 border-b border-border bg-card">
            <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
                <a className="flex items-center gap-3 font-semibold tracking-tight" href="/" aria-label="Morty home">
                    <span
                        aria-hidden="true"
                        className="flex size-9 items-center justify-center rounded-lg bg-primary text-2xl text-primary-foreground"
                    >
                        ∞
                    </span>
                    Morty
                </a>
                <div className="flex flex-wrap items-center gap-3">
                    {navigation}
                    {account ?? <span className="text-xs text-muted-foreground">Your agents. Connected.</span>}
                </div>
            </div>
        </header>
    );
}

export function Page({
    children,
    account,
    navigation,
}: {
    readonly children: ReactNode;
    readonly account?: ReactNode;
    readonly navigation?: ReactNode;
}) {
    return (
        <div className="min-h-dvh bg-background font-sans text-foreground">
            <AppHeader account={account} navigation={navigation} />
            <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>
        </div>
    );
}

export function App({
    bugReportDialog,
    state,
}: {
    readonly bugReportDialog: BugReportDialogStore;
    readonly state: AppState;
}) {
    // This component owns the dialog's single host for the application's
    // whole interactive life: it renders in every state, so the host survives
    // the loading → ready transition without remounting or cancelling an
    // in-flight send. The crash fallback mounts its own host only after this
    // tree has unmounted, so exactly one host exists at any time.
    return (
        <>
            <ApplicationContent state={state} />
            {(state.kind === "loading" || state.kind === "failed") && (
                <BugReportButton appearance="floating" dialog={bugReportDialog} />
            )}
            <BugReportDialogHost dialog={bugReportDialog} />
        </>
    );
}

function ApplicationContent({ state }: { readonly state: AppState }) {
    switch (state.kind) {
        case "loading":
            return (
                <SetupCardShell contentAlignment="center" titleId="bootstrap-loading">
                    <SetupCardTitle id="bootstrap-loading" size="compact">
                        Loading Morty
                    </SetupCardTitle>
                    <SetupCardSection className="flex justify-center">
                        <Spinner label="Loading Morty" size="large" />
                    </SetupCardSection>
                </SetupCardShell>
            );
        case "failed":
            return (
                <SetupCardShell
                    cardLeading={<SetupCardFailureIcon />}
                    contentAlignment="center"
                    showPageHeader
                    titleId="bootstrap-failed"
                >
                    <SetupCardTitle id="bootstrap-failed" size="compact">
                        Morty is unavailable
                    </SetupCardTitle>
                    <SetupCardDescription>
                        Check your connection and try again. Your saved computers are still here.
                    </SetupCardDescription>
                    <SetupCardSection>
                        <Button
                            className={setupPrimaryButtonClassName}
                            onClick={state.retry}
                            size={setupPrimaryButtonSize}
                        >
                            Retry
                        </Button>
                    </SetupCardSection>
                </SetupCardShell>
            );
        case "invalid-link":
            return (
                <SetupCardShell
                    cardLeading={<SetupCardFailureIcon />}
                    contentAlignment="center"
                    titleId="invalid-link-title"
                >
                    <div role="alert">
                        <SetupCardTitle id="invalid-link-title" size="compact">
                            This link is no longer valid
                        </SetupCardTitle>
                        <SetupCardDescription>
                            Ask for a new link. Morty has not switched to another computer.
                        </SetupCardDescription>
                    </div>
                    {state.continueHref !== null && (
                        <Button asChild variant="outline" className={`${setupPrimaryButtonClassName} mt-5 text-center`}>
                            <a href={state.continueHref}>Continue on your last computer</a>
                        </Button>
                    )}
                </SetupCardShell>
            );
        case "setup":
            return <SetupApplication notice={state.notice} returnHref={state.returnHref} />;
        case "authentication":
            return <RouterProvider router={state.router} />;
        case "signed-in":
            return <RouterProvider router={state.router} />;
    }
}

function SetupApplication({
    notice,
    returnHref,
}: {
    readonly notice: "access-ended" | "legacy" | "none";
    readonly returnHref: string | null;
}) {
    return (
        <SetupCardShell cardLeading={null} showPageHeader titleId="setup-title">
            {notice === "access-ended" && (
                <div role="status" className="mb-5 rounded-xl border border-primary/20 bg-primary/5 px-5 py-4 text-sm">
                    <p className="font-medium">Current access ended</p>
                    <p className="mt-1 text-muted-foreground">Your local agent and tasks keep running.</p>
                </div>
            )}
            {notice === "legacy" && (
                <div className="mb-5 rounded-xl border border-border px-5 py-4 text-sm" role="status">
                    Already using Morty? Open the link your agent gave you once, and this browser will remember your
                    computer.
                </div>
            )}
            {returnHref !== null && (
                <a
                    href={returnHref}
                    className="mb-5 inline-flex min-h-11 items-center rounded-lg text-sm text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                    ← Back to your last computer
                </a>
            )}
            <SetupCardTitle id="setup-title">
                {returnHref === null ? "Just one prompt." : "Connect another computer"}
            </SetupCardTitle>
            <SetupCardDescription>
                {returnHref === null
                    ? "Connect your agent. Continue from any browser."
                    : "Use the agent on the computer you want to add."}
            </SetupCardDescription>
            <div className="mt-8">
                <PairingInstruction />
            </div>
            <p className="mt-4 border-t border-border/50 pt-4 text-center text-xs leading-5 text-muted-foreground">
                Works with Codex, Claude Code, and Pi.
            </p>
        </SetupCardShell>
    );
}
