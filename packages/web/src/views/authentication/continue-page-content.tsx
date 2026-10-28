import type { ReactNode } from "react";
import { ButtonGroup } from "../../components/ui/button-group.tsx";
import { Button } from "../../index.ts";
import type { ContinueState } from "../../view-models/authentication/continue-store.ts";
import { describePageFailure } from "../../view-models/format-error.ts";
import { GlobalLoadingPage } from "../setup/global-loading-page.tsx";
import {
    SetupCardDescription,
    SetupCardFailureIcon,
    SetupCardShell,
    SetupCardTitle,
    setupPrimaryButtonClassName,
    setupPrimaryButtonSize,
} from "../setup/setup-card-shell.tsx";

function ContinueError({
    title,
    content,
    detail,
    children,
}: {
    readonly title: string;
    readonly content: ReactNode;
    /** Extra guidance that belongs to the failure itself, announced with it. */
    readonly detail?: ReactNode;
    readonly children?: ReactNode;
}) {
    return (
        <SetupCardShell
            cardClassName="pb-10"
            cardLeading={<SetupCardFailureIcon />}
            showPageHeader
            titleId="continue-title"
        >
            <div className="w-full" role="alert">
                <SetupCardTitle id="continue-title">{title}</SetupCardTitle>
                <SetupCardDescription>{content}</SetupCardDescription>
                {detail}
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
            <Button
                asChild
                className={`${setupPrimaryButtonClassName} text-center`}
                size={setupPrimaryButtonSize}
                variant="outline"
            >
                <a href={continueHref}>Continue on your last computer</a>
            </Button>
        );
    switch (state.kind) {
        case "session-opening":
        case "session-resuming":
            return <GlobalLoadingPage label="Opening session" />;
        case "session-failed": {
            const copy = describePageFailure(state.message, "Couldn't open this session");
            return (
                <ContinueError title={copy.title} content={copy.content}>
                    <ButtonGroup className="mt-6 w-full" size={setupPrimaryButtonSize}>
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
                    </ButtonGroup>
                </ContinueError>
            );
        }
        case "redeem-failed": {
            const copy = describePageFailure(state.message, "Couldn't continue");
            return (
                <ContinueError title={copy.title} content={copy.content}>
                    <ButtonGroup className="mt-6 w-full" size={setupPrimaryButtonSize}>
                        <Button className={setupPrimaryButtonClassName} onClick={retry} size={setupPrimaryButtonSize}>
                            Try again
                        </Button>
                        {fallback}
                    </ButtonGroup>
                </ContinueError>
            );
        }
        case "link-unavailable":
            return (
                <ContinueError
                    detail={
                        <div className="mt-4 w-full rounded-[16px] bg-muted/60 px-5 py-3.5">
                            <p className="text-12 tracking-[0.04em] text-morty-text-3 uppercase">Next step</p>
                            <p className="mt-0.5 text-14 leading-[22px] text-foreground">
                                {state.recovery === "setup"
                                    ? "Run setup again on that computer to get a new link."
                                    : "Ask for a new link."}
                            </p>
                        </div>
                    }
                    title="This link is no longer available"
                    content={state.message}
                >
                    {fallback !== null && (
                        <ButtonGroup className="mt-5 w-full" size={setupPrimaryButtonSize}>
                            {fallback}
                        </ButtonGroup>
                    )}
                </ContinueError>
            );
        case "identity-redeeming":
            return <GlobalLoadingPage label="Securely transferring Morty access" />;
        case "failed": {
            const copy = describePageFailure(state.message, "Couldn't continue");
            return (
                <ContinueError title={copy.title} content={copy.content}>
                    <ButtonGroup className="mt-6 w-full" size={setupPrimaryButtonSize}>
                        <Button className={setupPrimaryButtonClassName} onClick={retry} size={setupPrimaryButtonSize}>
                            Try again
                        </Button>
                        {fallback}
                    </ButtonGroup>
                </ContinueError>
            );
        }
        case "invalid":
            return (
                <ContinueError title="This transfer link is invalid" content="Ask for a new link.">
                    {fallback !== null && (
                        <ButtonGroup className="mt-5 w-full" size={setupPrimaryButtonSize}>
                            {fallback}
                        </ButtonGroup>
                    )}
                </ContinueError>
            );
    }
}
