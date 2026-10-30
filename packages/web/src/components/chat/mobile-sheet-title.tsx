import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";
import { mobileSheetTitleClassName } from "./mobile-sheet.ts";

/**
 * Title of a chat sheet presented from the bottom edge on phones. Every sheet uses
 * it so their titles share one size, weight, and color. Pass it as the child of
 * `Primitive.Title asChild` in dialogs so Radix keeps the aria-labelledby link.
 */
export function MobileSheetTitle({ children, className, ...props }: Readonly<ComponentProps<"h2">>) {
    return (
        <h2 {...props} className={cn(mobileSheetTitleClassName, className)}>
            {children}
        </h2>
    );
}
