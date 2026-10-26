import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";

/**
 * Renders the mobile session title into the header slot the chat shell
 * provides. Pure DOM plumbing: it resolves the slot once mounted.
 */
/**
 * Recorded effect exception: the effect only resolves the portal's DOM slot
 * after mount — DOM-ephemeral state, no asynchronous workflow.
 */
export function MobileSessionTitlePortal({
    children,
    variant = "default",
}: {
    readonly children: ReactNode;
    readonly variant?: "default" | "editing";
}) {
    const [slot, setSlot] = useState<HTMLElement | null>(null);
    useEffect(() => {
        setSlot(document.getElementById(dataTestId.mobileSessionTitleSlot));
    }, []);
    if (slot === null) {
        return null;
    }
    return createPortal(
        <div
            className={cn(
                "pointer-events-auto flex min-w-0 w-full max-w-full justify-center",
                variant === "editing"
                    ? "absolute inset-x-0 top-0 z-[2] min-h-full bg-card/95 px-3 py-3"
                    : "overflow-visible",
            )}
        >
            {children}
        </div>,
        slot,
    );
}
