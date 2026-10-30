import { X } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import { type ReactNode, useState } from "react";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import { mobileHeaderIconButtonBelowSmClassName } from "../chat/chat-header-control.ts";
import {
    mobileSheetCloseButtonPositionClassName,
    mobileSheetSurfaceClassName,
    mobileSheetTitleRowClassName,
} from "../chat/mobile-sheet.ts";
import { MobileSheetTitle } from "../chat/mobile-sheet-title.tsx";
import { Button } from "./cloud-button.tsx";
import { overlaySurfaceRadiusClassName } from "./overlay-surface.ts";

export function Dialog({
    title,
    description,
    onClose,
    busy = false,
    wide = false,
    mobileSheet = false,
    appearance = "default",
    testId,
    headerAction,
    children,
}: {
    readonly title: string;
    readonly description?: ReactNode;
    readonly onClose: () => void;
    readonly busy?: boolean;
    readonly wide?: boolean;
    /** Present as a bottom sheet on mobile, then return to a centered dialog at the sm breakpoint. */
    readonly mobileSheet?: boolean;
    readonly appearance?: "default" | "setup" | "surface";
    readonly testId?: string;
    readonly headerAction?: ReactNode;
    /** Place the dialog title yourself. Used when the title sits in a side column. */
    readonly children: ReactNode | ((title: ReactNode) => ReactNode);
}) {
    const [returnFocus] = useState(() =>
        typeof document !== "undefined" && document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
    );
    const setup = appearance === "setup";
    const surface = appearance === "surface";
    const titleEmbedded = typeof children === "function";
    const header = (
        <header
            className={
                titleEmbedded
                    ? "mb-0 pr-10 sm:pr-0"
                    : `${setup ? "mb-0" : surface ? (mobileSheet ? "mb-0 max-sm:pr-14 max-sm:pl-5 sm:mb-4" : "mb-4") : "mb-5"} ${headerAction === undefined ? (surface ? "pr-10" : "pr-7") : "pr-16"}`
            }
        >
            {surface && mobileSheet ? (
                <Primitive.Title asChild>
                    {/* The sm breakpoint is no longer a sheet, so it keeps the centered dialog's tighter tracking. */}
                    <MobileSheetTitle className={cn(mobileSheetTitleRowClassName, "sm:tracking-[-0.015em]")}>
                        {title}
                    </MobileSheetTitle>
                </Primitive.Title>
            ) : (
                <Primitive.Title
                    className={
                        setup
                            ? "text-24 font-semibold tracking-[-0.03em]"
                            : surface
                              ? "py-4 font-inter text-16 font-semibold tracking-[-0.015em]"
                              : "text-16 font-semibold tracking-tight"
                    }
                >
                    {title}
                </Primitive.Title>
            )}
            {description ? (
                <Primitive.Description
                    className={
                        setup
                            ? "mt-2 text-16 leading-[26px] text-muted-foreground"
                            : surface
                              ? "mt-1.5 text-13 text-morty-text-3"
                              : "mt-1.5 text-[13px] leading-5 text-muted-foreground"
                    }
                >
                    {description}
                </Primitive.Description>
            ) : null}
        </header>
    );
    return (
        <Primitive.Root
            open
            onOpenChange={(open) => {
                if (!open && !busy) {
                    onClose();
                }
            }}
        >
            <Primitive.Portal>
                <Primitive.Overlay className="fixed inset-0 z-50 bg-black/30 motion-safe:animate-cloud-enter" />
                <Primitive.Content
                    data-testid={testId}
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        returnFocus?.focus();
                    }}
                    className={
                        setup
                            ? `max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[560px] overflow-hidden ${overlaySurfaceRadiusClassName} border-[1px] border-white bg-card/90 p-8 shadow-module backdrop-blur sm:p-12 fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 overflow-y-auto outline-none motion-safe:animate-cloud-enter`
                            : surface
                              ? mobileSheet
                                  ? `fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] max-h-[calc(100dvh-0.75rem)] w-full flex-col overflow-hidden rounded-t-overlay pt-0 pb-[max(0.5rem,env(safe-area-inset-bottom))] font-inter text-13 text-foreground shadow-module outline-none motion-safe:animate-cloud-enter max-sm:[font-size:15px] max-sm:leading-[24px] sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:block sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] ${wide ? "sm:max-w-5xl" : "sm:max-w-lg"} sm:-translate-x-1/2 sm:-translate-y-1/2 sm:overflow-y-auto sm:rounded-overlay sm:border sm:bg-card/90 sm:p-2 sm:backdrop-blur ${mobileSheetSurfaceClassName}`
                                  : `fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${wide ? "max-w-5xl" : "max-w-lg"} -translate-x-1/2 -translate-y-1/2 overflow-y-auto ${overlaySurfaceRadiusClassName} border-[1px] border-white bg-card/90 p-2 font-inter text-13 text-foreground shadow-module backdrop-blur outline-none motion-safe:animate-cloud-enter`
                              : `fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${wide ? "max-w-5xl" : "max-w-lg"} -translate-x-1/2 -translate-y-1/2 overflow-y-auto ${overlaySurfaceRadiusClassName} border border-border bg-card p-6 text-[13px] leading-5 text-foreground shadow-lg outline-none motion-safe:animate-cloud-enter`
                    }
                >
                    {headerAction !== undefined && <div className="absolute right-14 top-3">{headerAction}</div>}
                    {typeof children === "function" ? (
                        children(header)
                    ) : (
                        <>
                            {header}
                            {children}
                        </>
                    )}
                    <Primitive.Close asChild>
                        <Button
                            disabled={busy}
                            variant="ghost"
                            size="icon"
                            aria-label="Close dialog"
                            data-testid={dataTestId.closeDialog}
                            className={
                                surface
                                    ? `absolute top-3 right-2 text-morty-text-3 hover:bg-morty-fill-opacity-2 hover:text-foreground sm:top-5 sm:right-5 sm:size-9 ${mobileHeaderIconButtonBelowSmClassName} ${mobileSheetCloseButtonPositionClassName}`
                                    : "absolute right-3 top-3"
                            }
                        >
                            <X aria-hidden="true" className={surface ? "size-4 max-sm:size-5" : "size-4"} />
                        </Button>
                    </Primitive.Close>
                </Primitive.Content>
            </Primitive.Portal>
        </Primitive.Root>
    );
}
