import { type AnyRouter, RouterProvider } from "@tanstack/react-router";
import { ArrowLeft, Unplug } from "lucide-react";
import { SetupConnectionGraphic } from "../../components/setup/setup-connection-graphic.tsx";
import { MortyAlert } from "../../components/ui/morty-alert.tsx";
import { Button, Spinner } from "../../index.ts";
import type { BugReportDialogStore } from "../../view-models/bug-report-dialog-store.ts";
import { PairingInstruction } from "../chat/pairing-instruction.tsx";
import { BugReportButton, BugReportDialogHost } from "../diagnostics/bug-report-button.tsx";
import { GlobalLoadingPage } from "../setup/global-loading-page.tsx";
import {
    SetupCardAlert,
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
    | { readonly kind: "failed"; readonly retry: () => void; readonly retrying: boolean }
    | { readonly kind: "invalid-link"; readonly continueHref: string | null }
    | { readonly kind: "unpaired" }
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
            return <GlobalLoadingPage label="Loading Morty" />;
        case "failed":
            return (
                <SetupCardShell
                    cardClassName="pb-10"
                    cardLeading={<SetupCardFailureIcon />}
                    showPageHeader
                    titleId="bootstrap-failed"
                >
                    <SetupCardTitle id="bootstrap-failed">Morty is unavailable</SetupCardTitle>
                    <SetupCardDescription>
                        Check your connection and try again. Your saved computers are still here.
                    </SetupCardDescription>
                    <SetupCardSection className="mt-4">
                        <Button
                            aria-busy={state.retrying}
                            className={setupPrimaryButtonClassName}
                            disabled={state.retrying}
                            onClick={state.retry}
                            size={setupPrimaryButtonSize}
                        >
                            {state.retrying ? (
                                <>
                                    <Spinner className="text-background" label="Retrying" />
                                    Retrying…
                                </>
                            ) : (
                                "Retry"
                            )}
                        </Button>
                    </SetupCardSection>
                </SetupCardShell>
            );
        case "unpaired":
            return (
                <SetupCardShell cardLeading={<SetupCardFailureIcon />} showPageHeader titleId="unpaired-title">
                    <SetupCardTitle id="unpaired-title">Browser not paired</SetupCardTitle>
                    <SetupCardDescription>Copied browser URLs don’t grant access.</SetupCardDescription>
                    <SetupCardAlert>Pair again with this computer.</SetupCardAlert>
                    <SetupCardDescription>Open your agent’s link or scan its QR code.</SetupCardDescription>
                    <SetupCardSection className="mt-4">
                        <PairingInstruction />
                    </SetupCardSection>
                </SetupCardShell>
            );
        case "invalid-link":
            return (
                <SetupCardShell cardLeading={<SetupCardFailureIcon />} showPageHeader titleId="invalid-link-title">
                    <SetupCardTitle id="invalid-link-title">This link is no longer valid</SetupCardTitle>
                    <SetupCardAlert>Ask for a new link. Morty has not switched to another computer.</SetupCardAlert>
                    {state.continueHref !== null && (
                        <Button
                            asChild
                            className={`${setupPrimaryButtonClassName} mt-5 text-center`}
                            size={setupPrimaryButtonSize}
                            variant="outline"
                        >
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
    const pageNotice =
        notice === "access-ended" ? (
            <MortyAlert
                className="w-full items-start justify-center rounded-[12px] border-primary/25 bg-primary/10 px-6 py-3 text-center text-foreground shadow-none [&>div]:flex-initial [&>svg]:mt-[3px] [&>svg]:text-primary"
                icon={Unplug}
                tone="info"
            >
                <p>
                    <span className="font-medium">Current access ended</span>{" "}
                    <span className="text-muted-foreground">Your local agent and tasks keep running.</span>
                </p>
            </MortyAlert>
        ) : notice === "legacy" ? (
            <MortyAlert
                className="w-full items-start justify-center rounded-[12px] border-[oklch(0.62_0.19_255/0.20)] bg-[oklch(0.62_0.19_255/0.08)] px-6 py-3 text-center text-foreground shadow-none [&>div]:flex-initial [&>svg]:mt-[3px] [&>svg]:text-[oklch(0.62_0.19_255)]"
                tone="info"
            >
                <p>
                    <span className="font-medium">Already using Morty?</span>{" "}
                    <span className="text-muted-foreground">
                        Open the link your agent gave you once, and this browser will remember your computer.
                    </span>
                </p>
            </MortyAlert>
        ) : undefined;

    const pageAction =
        returnHref === null ? undefined : (
            <Button asChild size="sm" variant="ghost">
                <a href={returnHref}>
                    <ArrowLeft aria-hidden="true" className="size-4" />
                    <span>Back to your last computer</span>
                </a>
            </Button>
        );

    return (
        <SetupCardShell pageAction={pageAction} pageNotice={pageNotice} showPageHeader titleId="setup-title">
            <SetupConnectionGraphic />
            <SetupCardTitle id="setup-title">
                {returnHref === null ? "Connect your agent to Morty" : "Connect another computer"}
            </SetupCardTitle>
            <SetupCardDescription>
                {returnHref === null
                    ? "Run one setup prompt in Codex, Claude Code, or Pi."
                    : "Run one setup prompt on the computer you want to add."}
            </SetupCardDescription>
            <div className="mt-4 w-full">
                <PairingInstruction />
            </div>
        </SetupCardShell>
    );
}
