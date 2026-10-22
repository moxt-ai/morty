import type { ReactNode } from "react";

const setupPageBackgroundClassName = "bg-[radial-gradient(circle_at_top,_#f6f7f9_0%,_#f0f1f4_48%)]";

export const setupPageClassName = `flex min-h-screen flex-col items-center justify-center overflow-y-auto ${setupPageBackgroundClassName} px-6 py-12 text-foreground`;

export const setupSectionClassName = "mx-auto w-full max-w-[560px]";

const setupSectionWideClassName = `${setupSectionClassName} md:max-w-[960px]`;

const setupCardClassName =
    "overflow-hidden rounded-3xl border-[1px] border-white bg-card/90 p-8 shadow-module backdrop-blur sm:p-12";

/** Vertical rhythm below title or description (24px top, 12px between children). */
const setupContentStackClassName = "mt-6 space-y-3";

export const setupPrimaryButtonClassName = "w-full min-h-11 !rounded-xl text-16";

function SetupCardLogo() {
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
