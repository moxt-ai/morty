import { Button, Spinner } from "../../index.ts";
import type { ContinueState } from "../../view-models/authentication/continue-store.ts";
import {
    SetupCardAlert,
    SetupCardDescription,
    SetupCardOpeningStatus,
    SetupCardSection,
    SetupCardShell,
    SetupCardTitle,
    setupPrimaryButtonClassName,
} from "../setup/setup-card-shell.tsx";

export function ContinuePageContent({
    enterMorty,
    continueHref = null,
    retry,
    state,
}: {
    readonly enterMorty: () => void;
    readonly continueHref?: string | null;
    readonly retry: () => void;
    readonly state: ContinueState;
}) {
    const fallback =
        continueHref === null ? null : (
            <a className="mt-5 inline-flex text-sm text-primary underline" href={continueHref}>
                Continue on your last computer
            </a>
        );
    switch (state.kind) {
        case "session-opening":
        case "session-resuming":
            return (
                <SetupCardShell titleId="continue-title">
                    <SetupCardTitle id="continue-title">Continue native session</SetupCardTitle>
                    <SetupCardDescription>Opening the original session in Morty.</SetupCardDescription>
                    <SetupCardSection className="flex items-center gap-3">
                        <Spinner label="Opening session" />
                        <span className="text-14 text-muted-foreground">Opening session…</span>
                    </SetupCardSection>
                </SetupCardShell>
            );
        case "session-failed":
            return (
                <SetupCardShell titleId="continue-title">
                    <SetupCardTitle id="continue-title">Continue native session</SetupCardTitle>
                    <SetupCardAlert>{state.message}</SetupCardAlert>
                    <SetupCardSection>
                        <Button className={setupPrimaryButtonClassName} onClick={retry}>
                            Try again
                        </Button>
                        <Button className={setupPrimaryButtonClassName} onClick={enterMorty} variant="outline">
                            Go to Morty
                        </Button>
                    </SetupCardSection>
                </SetupCardShell>
            );
        case "redeem-failed":
            return (
                <SetupCardShell titleId="continue-title">
                    <SetupCardTitle id="continue-title">Continue native session</SetupCardTitle>
                    <SetupCardAlert>{state.message}</SetupCardAlert>
                    <SetupCardSection>
                        <Button className={setupPrimaryButtonClassName} onClick={retry}>
                            Try again
                        </Button>
                        {fallback}
                    </SetupCardSection>
                </SetupCardShell>
            );
        case "identity-redeeming":
            return (
                <SetupCardShell titleId="continue-title">
                    <SetupCardTitle id="continue-title">Continue in Morty</SetupCardTitle>
                    <SetupCardOpeningStatus ariaLabel="Securely transferring Morty access">
                        <Spinner label="Securely transferring Morty access" />
                        <span>Securely transferring Morty access…</span>
                    </SetupCardOpeningStatus>
                </SetupCardShell>
            );
        case "failed":
            return (
                <SetupCardShell titleId="continue-title">
                    <SetupCardTitle id="continue-title">Continue in Morty</SetupCardTitle>
                    <SetupCardAlert>{state.message}</SetupCardAlert>
                    <SetupCardSection>
                        <Button className={setupPrimaryButtonClassName} onClick={retry}>
                            Try again
                        </Button>
                        {fallback}
                    </SetupCardSection>
                </SetupCardShell>
            );
        case "invalid":
            return (
                <SetupCardShell titleId="continue-title">
                    <SetupCardTitle id="continue-title">Continue in Morty</SetupCardTitle>
                    <SetupCardAlert>This transfer link is invalid.</SetupCardAlert>
                    {fallback}
                </SetupCardShell>
            );
    }
}
