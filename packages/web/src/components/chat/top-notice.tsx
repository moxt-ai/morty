import type { ReactNode } from "react";

/**
 * Where notices about this browser's access appear, stacked in order: centered at the top on larger screens, and on
 * phones below the 56px header (40px controls with 8px above and below) so they never cover its navigation. Both clear
 * the safe area, and sit below the dialog overlay so a dialog they open covers them.
 */
export function TopNoticeStack({ children }: { readonly children: ReactNode }) {
    return (
        <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-40 flex flex-col items-center gap-2 px-4 max-sm:top-[calc(env(safe-area-inset-top)+4rem)]">
            {children}
        </div>
    );
}

export const topNoticeCardClassName =
    "pointer-events-auto w-full max-w-md rounded-lg border border-border bg-background px-4 py-3 text-sm shadow-lg";

/** Notice actions keep a 44px touch target on phones. */
export const topNoticeActionClassName = "max-sm:min-h-11";
