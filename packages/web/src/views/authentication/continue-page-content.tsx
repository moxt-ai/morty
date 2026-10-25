import type { ReactNode } from "react";
import { Button, Spinner } from "../../index.ts";
import type { ContinueState } from "../../view-models/authentication/continue-store.ts";
import { describePageFailure } from "../../view-models/format-error.ts";
import {
    SetupCardDescription,
    SetupCardFailureIcon,
    SetupCardOpeningStatus,
    SetupCardSection,
    SetupCardShell,
    SetupCardTitle,
    setupPrimaryButtonClassName,
    setupPrimaryButtonSize,
} from "../setup/setup-card-shell.tsx";

function ContinueError({
    title,
    content,
    children,
}: {
    readonly title: string;
    readonly content: ReactNode;
    readonly children?: ReactNode;
}) {
    return (
        <SetupCardShell cardLeading={<SetupCardFailureIcon />} contentAlignment="center" titleId="continue-title">
            <div role="alert">
                <SetupCardTitle id="continue-title" size="compact">
                    {title}
                </SetupCardTitle>
                <SetupCardDescription>{content}</SetupCardDescription>
            </div>
            {children}
        </SetupCardShell>
    );
}

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
            <Button asChild variant="outline" className={`${setupPrimaryButtonClassName} mt-5 text-center`}>
                <a href={continueHref}>Continue on your last computer</a>
            </Button>
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
        case "session-failed": {
            const copy = describePageFailure(state.message, "Couldn't open this session");
            return (
                <ContinueError title={copy.title} content={copy.content}>
                    <SetupCardSection>
                        <Button className={setupPrimaryButtonClassName} onClick={retry} size={setupPrimaryButtonSize}>
                            Try again
                        </Button>
                        <Button
                            className={setupPrimaryButtonClassName}
                            onClick={enterMorty}
                            size={setupPrimaryButtonSize}
                            variant="outline"
                        >
                            Go to Morty
                        </Button>
                    </SetupCardSection>
                </ContinueError>
            );
        }
        case "redeem-failed": {
            const copy = describePageFailure(state.message, "Couldn't continue");
            return (
                <ContinueError title={copy.title} content={copy.content}>
                    <SetupCardSection>
                        <Button className={setupPrimaryButtonClassName} onClick={retry} size={setupPrimaryButtonSize}>
                            Try again
                        </Button>
                        {fallback}
                    </SetupCardSection>
                </ContinueError>
            );
        }
        case "link-unavailable":
            return (
                <ContinueError
                    title="This link is no longer available"
                    content={
                        <>
                            <span className="block">{state.message}</span>
                            <span className="mt-2 block">
                                {state.recovery === "setup"
                                    ? "Run setup again on that computer to get a new link."
                                    : "Ask for a new link."}
                            </span>
                        </>
                    }
                >
                    {fallback}
                </ContinueError>
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
        case "failed": {
            const copy = describePageFailure(state.message, "Couldn't continue");
            return (
                <ContinueError title={copy.title} content={copy.content}>
                    <SetupCardSection>
                        <Button className={setupPrimaryButtonClassName} onClick={retry}>
                            Try again
                        </Button>
                        {fallback}
                    </SetupCardSection>
                </ContinueError>
            );
        }
        case "invalid":
            return (
                <ContinueError title="This transfer link is invalid" content="Ask for a new link.">
                    {fallback}
                </ContinueError>
            );
    }
}
