import { type AnyRouter, RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Spinner } from "../../index.ts";
import type { BugReportDialogStore } from "../../view-models/bug-report-dialog-store.ts";
import { PairingInstruction } from "../chat/pairing-instruction.tsx";
import { BugReportButton, BugReportDialogHost } from "../diagnostics/bug-report-button.tsx";
import {
    SetupCardAlert,
    SetupCardDescription,
    SetupCardSection,
    SetupCardShell,
    SetupCardTitle,
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
                <SetupCardShell titleId="bootstrap-loading">
                    <SetupCardTitle id="bootstrap-loading">Loading Morty</SetupCardTitle>
                    <SetupCardSection className="flex justify-center">
                        <Spinner label="Loading Morty" />
                    </SetupCardSection>
                </SetupCardShell>
            );
        case "failed":
            return (
                <SetupCardShell titleId="bootstrap-failed">
                    <SetupCardTitle id="bootstrap-failed">Morty is unavailable</SetupCardTitle>
                    <SetupCardAlert>
                        Check your connection and try again. Your saved computers are still here.
                    </SetupCardAlert>
                    <Button className="mt-4" onClick={state.retry}>
                        Retry
                    </Button>
                </SetupCardShell>
            );
        case "invalid-link":
            return (
                <SetupCardShell titleId="invalid-link-title">
                    <SetupCardTitle id="invalid-link-title">This link is no longer valid</SetupCardTitle>
                    <SetupCardAlert>Ask for a new link. Morty has not switched to another computer.</SetupCardAlert>
                    {state.continueHref !== null && (
                        <a className="mt-5 inline-flex text-primary underline" href={state.continueHref}>
                            Continue on your last computer
                        </a>
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
        <SetupCardShell titleId="setup-title">
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
                <a href={returnHref} className="mb-5 inline-flex text-sm text-primary underline">
                    Continue on your last computer
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
