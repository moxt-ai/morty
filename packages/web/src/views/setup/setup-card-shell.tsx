import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { MortyLogoMark } from "@/components/brand/morty-logo";
import { HarnessMark } from "@/components/chat/harness-mark";
import { cn } from "@/lib/utils";
import { overlaySurfaceRadiusClassName } from "../../components/ui/overlay-surface.ts";

const setupPageBackgroundClassName = "bg-[radial-gradient(circle_at_top,_#f6f7f9_0%,_#f0f1f4_48%)]";

const setupPageClassName = `flex min-h-screen flex-col items-center justify-center overflow-y-auto ${setupPageBackgroundClassName} px-6 py-12 text-foreground`;

export const setupSectionClassName = "mx-auto w-full max-w-[460px]";

const setupSectionWideClassName = `${setupSectionClassName} md:max-w-[960px]`;

export const setupCardClassName = `flex flex-col items-center overflow-hidden ${overlaySurfaceRadiusClassName} border-[1px] border-white bg-card/90 px-8 pt-10 pb-6 text-center shadow-module backdrop-blur`;

/** Light gray surface behind the setup connection arc; the logo badge reuses it so both read as one card surface. */
const setupConnectionBandFill = "#E8ECF1";

/** Vertical rhythm below title or description (24px top, 12px between children). */
const setupContentStackClassName = "mt-6 w-full space-y-3";

/** Full-width setup actions; pair with `setupPrimaryButtonSize` on cloud `Button`. */
export const setupPrimaryButtonClassName = "w-full !rounded-[24px]";

export const setupPrimaryButtonSize = "lg" as const;

/** Primary heading on setup card surfaces (`SetupPageWithHeader`, `SetupCardShell` with page header). */
const setupCardTitleClassName = "max-w-md text-24 font-semibold tracking-[-0.03em]";

function SetupCardLogo() {
    return <MortyLogoMark className="mb-6" size={56} />;
}

export function SetupConnectionGraphic({ className = "" }: { readonly className?: string }) {
    return (
        <figure
            aria-label="Codex, Claude Code, and Pi connect to Morty"
            className={cn("relative -mt-10 mb-6 h-[140px] w-[calc(100%+4rem)] shrink-0", className)}
        >
            <svg
                aria-hidden="true"
                className="absolute inset-0 size-full"
                fill="none"
                preserveAspectRatio="none"
                viewBox="0 0 400 140"
            >
                <path d="M0 0H400V72C278 126 122 126 0 72Z" fill={setupConnectionBandFill} />
                <path
                    d="M400 72C278 126 122 126 0 72"
                    stroke="var(--morty-fill-white)"
                    strokeLinecap="round"
                    strokeWidth="1"
                />
            </svg>
            <span
                aria-hidden="true"
                className="absolute top-6 left-[30%] flex size-11 -translate-x-1/2 items-center justify-center rounded-[14px] bg-white opacity-80"
            >
                <HarnessMark agentRef="codex" appearance="line" className="size-[18px] text-[#171717]" label="Codex" />
            </span>
            <span
                aria-hidden="true"
                className="absolute top-6 left-1/2 flex size-11 -translate-x-1/2 items-center justify-center rounded-[14px] bg-white opacity-80"
            >
                <HarnessMark
                    agentRef="claude"
                    appearance="line"
                    className="size-[18px] text-[#171717]"
                    label="Claude Code"
                />
            </span>
            <span
                aria-hidden="true"
                className="absolute top-6 left-[70%] flex size-11 -translate-x-1/2 items-center justify-center rounded-[14px] bg-white opacity-80"
            >
                <HarnessMark
                    agentRef="pi"
                    appearance="line"
                    className="size-4 rounded-none text-foreground [&>svg]:size-4"
                    label="Pi"
                />
            </span>
            <span
                aria-hidden="true"
                className="absolute top-[77px] left-1/2 flex size-[70px] -translate-x-1/2 items-center justify-center rounded-[22px]"
                style={{ backgroundColor: setupConnectionBandFill }}
            >
                <MortyLogoMark size={56} />
            </span>
        </figure>
    );
}

function SetupPageHeader() {
    return (
        <header className="w-full shrink-0">
            <div className="mx-auto flex min-h-16 max-w-6xl items-center px-4 py-3 sm:px-6">
                <a className="flex items-center gap-3 font-semibold tracking-tight" href="/" aria-label="Morty home">
                    <MortyLogoMark size={36} />
                    Morty
                </a>
            </div>
        </header>
    );
}

/** Top logo bar plus a centered content column; pairs with a single card section surface. */
export function SetupPageWithHeader({
    children,
    pageAction,
    pageNotice,
}: {
    readonly children: ReactNode;
    readonly pageAction?: ReactNode;
    readonly pageNotice?: ReactNode;
}) {
    const hasPageLeading = pageNotice !== undefined || pageAction !== undefined;
    return (
        <main className={`flex min-h-screen flex-col overflow-y-auto ${setupPageBackgroundClassName} text-foreground`}>
            <SetupPageHeader />
            {pageNotice !== undefined && <div className="w-full px-6">{pageNotice}</div>}
            <div
                className={
                    hasPageLeading
                        ? "flex flex-1 flex-col items-center justify-center px-6 py-6"
                        : "flex flex-1 flex-col items-center justify-center px-6 py-12"
                }
            >
                {pageAction !== undefined && <div className="mb-6">{pageAction}</div>}
                {children}
            </div>
        </main>
    );
}

export function SetupCardFailureIcon() {
    return (
        <span className="mb-6 flex size-12 items-center justify-center rounded-full bg-destructive/5">
            <CircleAlert aria-hidden="true" className="size-6 shrink-0 text-destructive" />
        </span>
    );
}

export function SetupCardTitle({
    id,
    children,
    className = "",
}: {
    readonly id: string;
    readonly children: ReactNode;
    readonly className?: string;
}) {
    return (
        <h1 id={id} className={cn(setupCardTitleClassName, className)}>
            {children}
        </h1>
    );
}

export function SetupCardDescription({
    children,
    className = "",
}: {
    readonly children: ReactNode;
    readonly className?: string;
}) {
    return <p className={`mt-2 max-w-xl text-16 leading-[26px] text-morty-text-2 ${className}`}>{children}</p>;
}

export function SetupCardAlert({
    children,
    className = "",
}: {
    readonly children: ReactNode;
    readonly className?: string;
}) {
    return (
        <p role="alert" className={cn("mt-2 max-w-xl text-16 leading-[26px] text-morty-text-2", className)}>
            {children}
        </p>
    );
}

export function SetupCardSection({
    children,
    className = "",
}: {
    readonly children: ReactNode;
    readonly className?: string;
}) {
    return <div className={cn(setupContentStackClassName, className)}>{children}</div>;
}

export function SetupCardOpeningStatus({
    ariaLabel,
    children,
}: {
    readonly ariaLabel: string;
    readonly children: ReactNode;
}) {
    return (
        <p
            role="status"
            aria-label={ariaLabel}
            className="mt-2 flex max-w-xl items-start gap-2 text-16 leading-[26px] text-muted-foreground [&>span:first-child]:h-[26px]"
        >
            {children}
        </p>
    );
}

export function SetupCardShell({
    cardClassName = "",
    cardLeading,
    pageAction,
    pageNotice,
    showPageHeader = false,
    titleId,
    children,
    wide = false,
}: {
    readonly cardClassName?: string;
    readonly cardLeading?: ReactNode | null;
    readonly pageAction?: ReactNode;
    readonly pageNotice?: ReactNode;
    readonly showPageHeader?: boolean;
    readonly titleId: string;
    readonly children: ReactNode;
    readonly wide?: boolean;
}) {
    const leading =
        cardLeading === undefined ? (
            showPageHeader ? null : (
                <SetupCardLogo />
            )
        ) : cardLeading === null ? null : (
            cardLeading
        );
    const cardSurfaceClassName = cn(setupCardClassName, cardClassName);
    const sectionClassName = wide ? setupSectionWideClassName : setupSectionClassName;
    const card = showPageHeader ? (
        <section aria-labelledby={titleId} className={`${sectionClassName} ${cardSurfaceClassName}`}>
            {leading}
            {children}
        </section>
    ) : (
        <section aria-labelledby={titleId} className={sectionClassName}>
            <div className={cardSurfaceClassName}>
                {leading}
                {children}
            </div>
        </section>
    );
    if (showPageHeader) {
        return (
            <SetupPageWithHeader pageAction={pageAction} pageNotice={pageNotice}>
                {card}
            </SetupPageWithHeader>
        );
    }
    return <main className={setupPageClassName}>{card}</main>;
}
