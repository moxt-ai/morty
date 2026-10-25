import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { overlaySurfaceRadiusClassName } from "../../components/ui/overlay-surface.ts";

const setupPageBackgroundClassName = "bg-[radial-gradient(circle_at_top,_#f6f7f9_0%,_#f0f1f4_48%)]";

export const setupPageClassName = `flex min-h-screen flex-col items-center justify-center overflow-y-auto ${setupPageBackgroundClassName} px-6 py-12 text-foreground`;

export const setupSectionClassName = "mx-auto w-full max-w-[480px]";

const setupSectionWideClassName = `${setupSectionClassName} md:max-w-[960px]`;

const setupCardClassName = `overflow-hidden ${overlaySurfaceRadiusClassName} border-[1px] border-white bg-card/90 px-8 py-6 shadow-module backdrop-blur sm:px-12`;

const setupCardCenteredClassName = `${setupCardClassName} flex flex-col items-center text-center`;

/** Vertical rhythm below title or description (24px top, 12px between children). */
const setupContentStackClassName = "mt-6 space-y-3";

/** Full-width setup actions; pair with `setupPrimaryButtonSize` on cloud `Button`. */
export const setupPrimaryButtonClassName = "w-full !rounded-xl";

export const setupPrimaryButtonSize = "lg" as const;

const mortyLogoMarkClassName = "flex items-center justify-center bg-primary text-xl font-bold text-primary-foreground";

function MortyLogoMark({ layout }: { readonly layout: "header" | "card" }) {
    if (layout === "header") {
        return (
            <span aria-hidden="true" className={`${mortyLogoMarkClassName} size-9 rounded-lg`}>
                M
            </span>
        );
    }

    return <div className={`${mortyLogoMarkClassName} mb-6 size-14 rounded-[16px]`}>M</div>;
}

function SetupCardLogo() {
    return <MortyLogoMark layout="card" />;
}

function SetupPageHeader() {
    return (
        <header className="w-full shrink-0">
            <div className="mx-auto flex min-h-16 max-w-6xl items-center px-4 py-3 sm:px-6">
                <a className="flex items-center gap-3 font-semibold tracking-tight" href="/" aria-label="Morty home">
                    <MortyLogoMark layout="header" />
                    Morty
                </a>
            </div>
        </header>
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
    size = "default",
}: {
    readonly id: string;
    readonly children: ReactNode;
    readonly size?: "default" | "compact";
}) {
    return (
        <h1
            id={id}
            className={`max-w-md ${size === "compact" ? "text-18" : "text-32"} font-semibold tracking-[-0.035em]`}
        >
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
    return <p className={`mt-2 max-w-xl text-16 leading-[26px] text-muted-foreground ${className}`}>{children}</p>;
}

export function SetupCardSection({
    children,
    className = "",
}: {
    readonly children: ReactNode;
    readonly className?: string;
}) {
    return <div className={`${setupContentStackClassName} ${className}`}>{children}</div>;
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
    cardLeading,
    contentAlignment = "start",
    showPageHeader = false,
    titleId,
    children,
    wide = false,
}: {
    readonly cardLeading?: ReactNode | null;
    readonly contentAlignment?: "start" | "center";
    readonly showPageHeader?: boolean;
    readonly titleId: string;
    readonly children: ReactNode;
    readonly wide?: boolean;
}) {
    const leading = cardLeading === undefined ? <SetupCardLogo /> : cardLeading === null ? null : cardLeading;
    const card = (
        <section aria-labelledby={titleId} className={wide ? setupSectionWideClassName : setupSectionClassName}>
            <div className={contentAlignment === "center" ? setupCardCenteredClassName : setupCardClassName}>
                {leading}
                {children}
            </div>
        </section>
    );
    if (showPageHeader) {
        return (
            <main
                className={`flex min-h-screen flex-col overflow-y-auto ${setupPageBackgroundClassName} text-foreground`}
            >
                <SetupPageHeader />
                <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">{card}</div>
            </main>
        );
    }
    return <main className={setupPageClassName}>{card}</main>;
}
