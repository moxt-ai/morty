import type { ReactNode } from "react";

/**
 * Where notices about this browser's access appear, stacked in order above the conversation: below the header on
 * phones, and above the conversation card on larger screens. They stay until the user acts on them, so they take their
 * own room and move the conversation down instead of covering what it shows. With no notice the stack takes no room.
 */
export function TopNoticeStack({ children }: { readonly children: ReactNode }) {
    return (
        <div className="flex shrink-0 flex-col items-center gap-2 px-3 has-[section]:pt-2 max-sm:has-[section]:pb-2 sm:pr-2 sm:pl-0">
            {children}
        </div>
    );
}

export const topNoticeCardClassName =
    "w-full max-w-[920px] rounded-lg border border-border bg-background px-4 py-3 text-sm";

/** Notice actions keep a 44px touch target on phones. */
export const topNoticeActionClassName = "max-sm:min-h-11";
