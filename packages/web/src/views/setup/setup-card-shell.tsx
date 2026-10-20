import type { ReactNode } from "react";

export const setupPageBackgroundClassName = "bg-[radial-gradient(circle_at_top,_#f6f7f9_0%,_#f0f1f4_48%)]";

export const setupPageClassName = `flex min-h-screen flex-col items-center justify-center overflow-y-auto ${setupPageBackgroundClassName} px-6 py-12 text-foreground`;

export const setupSectionClassName = "mx-auto w-full max-w-[560px]";

export const setupSectionWideClassName = `${setupSectionClassName} md:max-w-[960px]`;

export const setupCardClassName =
    "overflow-hidden rounded-3xl border-[1px] border-white bg-card/90 p-8 shadow-module backdrop-blur sm:p-12";

/** Vertical rhythm below title or description (24px top, 12px between children). */
export const setupContentStackClassName = "mt-6 space-y-3";

export const setupMonoFieldClassName =
    "w-full resize-none overflow-hidden rounded-lg border-[0.5px] border-border/50 bg-morty-fill-opacity-2 px-4 py-3 font-mono text-14 leading-[22px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const setupPrimaryButtonClassName = "w-full min-h-11 !rounded-xl text-16";

export const setupSecondaryTextClassName = "text-13 leading-[22px] text-muted-foreground";

export const setupFootnoteClassName = "text-13 leading-[22px] text-morty-text-3";

export const setupDetailsListClassName =
    "grid gap-3 rounded-lg border-[0.5px] border-border/50 bg-morty-fill-opacity-2 px-4 py-4 text-14";

export const setupDialogContentClassName = `max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[560px] ${setupCardClassName} fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 overflow-y-auto outline-none motion-safe:animate-cloud-enter`;

export const setupDialogTitleClassName = "text-32 font-semibold tracking-[-0.035em]";

export const setupDialogDescriptionClassName = "mt-2 text-16 leading-[26px] text-muted-foreground";

export function SetupCardLogo() {
    return (
        <div className="mb-6 flex size-14 items-center justify-center rounded-[16px] bg-primary text-xl font-bold text-primary-foreground">
            M
        </div>
    );
}

export function SetupCardTitle({ id, children }: { readonly id: string; readonly children: ReactNode }) {
    return (
        <h1 id={id} className="max-w-md text-32 font-semibold tracking-[-0.035em]">
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

export function SetupCardAlert({
    children,
    className = "",
}: {
    readonly children: ReactNode;
    readonly className?: string;
}) {
    return (
        <p role="alert" className={`mt-2 max-w-xl text-16 leading-[26px] text-destructive ${className}`}>
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

export function SetupCardDetailsList({ children }: { readonly children: ReactNode }) {
    return <dl className={`mt-6 ${setupDetailsListClassName}`}>{children}</dl>;
}

export function SetupCardShell({
    titleId,
    children,
    wide = false,
}: {
    readonly titleId: string;
    readonly children: ReactNode;
    readonly wide?: boolean;
}) {
    return (
        <main className={setupPageClassName}>
            <section aria-labelledby={titleId} className={wide ? setupSectionWideClassName : setupSectionClassName}>
                <div className={setupCardClassName}>
                    <SetupCardLogo />
                    {children}
                </div>
            </section>
        </main>
    );
}
