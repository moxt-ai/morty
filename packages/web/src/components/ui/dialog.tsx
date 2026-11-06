import { X } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import { type ReactNode, useRef, useState } from "react";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import { mobileHeaderIconButtonBelowSmClassName } from "../chat/chat-header-control.ts";
import {
    mobileSheetCloseButtonPositionClassName,
    mobileSheetSurfaceClassName,
    mobileSheetTitleRowClassName,
} from "../chat/mobile-sheet.ts";
import { MobileSheetTitle } from "../chat/mobile-sheet-title.tsx";
import { useDialogBodyClippedEdges } from "../utils/use-dialog-body-clipped-edges.ts";
import { Button } from "./cloud-button.tsx";
import {
    type DialogAppearance,
    type DialogVariant,
    dialogVariantLayout,
    resolveDialogGeneration,
} from "./dialog-variant.ts";
import { overlaySurfacePanelClassName, overlaySurfaceRadiusClassName } from "./overlay-surface.ts";
import {
    centeredOverlayHorizontalInsetClassName,
    type DialogSize,
    dialogStandardMaxWidthClassName,
    sharedDialogDesktopMaxWidthClassName,
    sharedDialogMobileSheetDesktopMaxWidthClassName,
} from "./overlay-width.ts";
import { ScrollArea } from "./scroll-area.tsx";

export { dialogVariantCatalog, dialogVariantLayout } from "./dialog-variant.ts";
export type { DialogAppearance, DialogSize, DialogVariant };

/** Sections inside a default dialog body. The dialog header and `footer` stay outside the scroll region. */
export const dialogBodyStackClassName = "flex flex-col gap-5";

/** Subsection label inside a default dialog body (below header description). */
export const dialogSectionTitleClassName = "text-[13px] font-medium leading-5 text-foreground";

/** Primary/cancel row at the bottom of a default dialog body. */
export const dialogFooterActionsClassName = "mt-5 flex justify-end gap-2";

/** Pinned `footer` slot: 20px above the actions, 24px on the sides and below. */
export const dialogPinnedFooterActionsClassName = "flex justify-end gap-2 px-6 pt-5 pb-6";

/** Surface-appearance body inset inside the outer `p-2` panel shell (not used on default `p-6` cards). */
export const dialogSurfaceBodyClassName = "space-y-5 px-3 pb-4 sm:px-5 sm:pb-5";

/** Surface-appearance section label above grouped cards (e.g. Devices with access). */
export const dialogSurfaceSectionHeadingClassName = "mb-2 px-0.5 text-12 font-medium leading-4 text-morty-text-3";

export function Dialog({
    title,
    description,
    onClose,
    busy = false,
    variant,
    size,
    wide = false,
    mobileSheet,
    appearance,
    testId,
    headerAction,
    footer,
    children,
}: {
    readonly title: string;
    readonly description?: ReactNode;
    readonly onClose: () => void;
    readonly busy?: boolean;
    /** Applies default `size`, `appearance`, and `mobileSheet` from {@link dialogVariantLayout}. */
    readonly variant?: DialogVariant;
    /** Overrides variant desktop max-width tier. */
    readonly size?: DialogSize;
    /** @deprecated Prefer `size="wide"`. */
    readonly wide?: boolean;
    /** Present as a bottom sheet on mobile, then return to a centered dialog at the sm breakpoint. */
    readonly mobileSheet?: boolean;
    readonly appearance?: DialogAppearance;
    readonly testId?: string;
    readonly headerAction?: ReactNode;
    /** Stays below the scrolling body. Default appearance only; the header stays above it. */
    readonly footer?: ReactNode;
    /** Place the dialog title yourself. Used when the title sits in a side column. */
    readonly children: ReactNode | ((title: ReactNode) => ReactNode);
}) {
    const [returnFocus] = useState(() =>
        typeof document !== "undefined" && document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
    );
    const bodyScrollRef = useRef<HTMLDivElement>(null);
    const { bodyEdges, syncBodyEdges } = useDialogBodyClippedEdges(bodyScrollRef);
    const generated = resolveDialogGeneration({
        ...(appearance !== undefined ? { appearance } : {}),
        ...(mobileSheet !== undefined ? { mobileSheet } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(variant !== undefined ? { variant } : {}),
        wide,
    });
    const setup = generated.appearance === "setup";
    const surface = generated.appearance === "surface";
    const variantPreset = variant !== undefined ? dialogVariantLayout[variant] : undefined;
    const defaultAppearanceHeaderMarginBottomClassName = variantPreset?.headerMarginBottomClassName ?? "pb-5";
    const defaultAppearanceDescriptionMarginTopClassName = variantPreset?.descriptionMarginTopClassName ?? "mt-1.5";
    const defaultAppearanceDescriptionTextClassName = "text-14 leading-5";
    const desktopMaxWidthClassName = sharedDialogDesktopMaxWidthClassName(generated.size);
    const mobileSheetDesktopMaxWidthClassName = sharedDialogMobileSheetDesktopMaxWidthClassName(generated.size);
    const titleEmbedded = typeof children === "function";
    const defaultAppearance = !setup && !surface;
    /** Title and footer stay put; only the body scrolls once the dialog reaches its max height. */
    const pinsChrome = defaultAppearance && !titleEmbedded;
    const dialogScrollPaddingClassName = setup
        ? "p-8 sm:p-12"
        : surface
          ? generated.mobileSheet
              ? "pt-0 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-2"
              : "p-2"
          : "p-6";
    const titleNode =
        surface && generated.mobileSheet ? (
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
        );
    const closeButton = (className: string) => (
        <Primitive.Close asChild>
            <Button
                disabled={busy}
                variant="ghost"
                size="icon"
                aria-label="Close dialog"
                data-testid={dataTestId.closeDialog}
                className={className}
            >
                <X aria-hidden="true" className={surface ? "size-4 max-sm:size-5" : "size-4"} />
            </Button>
        </Primitive.Close>
    );
    const headerEndPaddingClassName = defaultAppearance
        ? ""
        : headerAction === undefined
          ? surface
              ? "pr-10"
              : "pr-7"
          : "pr-16";
    const header = (
        <header
            className={cn(
                pinsChrome && "shrink-0 px-6 pt-6",
                titleEmbedded
                    ? "mb-0 pr-10 sm:pr-0"
                    : cn(
                          setup
                              ? "mb-0"
                              : surface
                                ? generated.mobileSheet
                                    ? "mb-0 max-sm:pr-14 max-sm:pl-5 sm:mb-4"
                                    : "mb-4"
                                : defaultAppearanceHeaderMarginBottomClassName,
                          headerEndPaddingClassName,
                      ),
            )}
        >
            {defaultAppearance ? (
                <div className={cn("relative flex items-center", headerAction === undefined ? "pr-11" : "pr-24")}>
                    {titleNode}
                    {headerAction !== undefined ? (
                        <div className="absolute -right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
                            {headerAction}
                            {closeButton("")}
                        </div>
                    ) : (
                        closeButton("absolute -right-1.5 top-1/2 -translate-y-1/2")
                    )}
                </div>
            ) : (
                titleNode
            )}
            {description ? (
                <Primitive.Description
                    className={
                        setup
                            ? "mt-2 text-16 leading-[26px] text-muted-foreground"
                            : surface
                              ? "mt-1.5 text-13 text-morty-text-3"
                              : `${defaultAppearanceDescriptionMarginTopClassName} ${defaultAppearanceDescriptionTextClassName} text-muted-foreground`
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
                            ? `max-h-[calc(100dvh-2rem)] ${centeredOverlayHorizontalInsetClassName} ${dialogStandardMaxWidthClassName} overflow-hidden ${overlaySurfaceRadiusClassName} border-[1px] border-white bg-card/90 shadow-module backdrop-blur fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 outline-none motion-safe:animate-cloud-enter`
                            : surface
                              ? generated.mobileSheet
                                  ? cn(
                                        "fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] max-h-[calc(100dvh-0.75rem)] w-full flex-col overflow-hidden rounded-t-overlay font-inter text-13 text-foreground outline-none motion-safe:animate-cloud-enter max-sm:[font-size:15px] max-sm:leading-[24px] sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:block sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-overlay",
                                        mobileSheetDesktopMaxWidthClassName,
                                        overlaySurfacePanelClassName,
                                        mobileSheetSurfaceClassName,
                                    )
                                  : cn(
                                        `fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] ${centeredOverlayHorizontalInsetClassName} ${desktopMaxWidthClassName} -translate-x-1/2 -translate-y-1/2 overflow-hidden ${overlaySurfaceRadiusClassName} font-inter text-13 text-foreground outline-none motion-safe:animate-cloud-enter`,
                                        overlaySurfacePanelClassName,
                                    )
                              : `fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] flex-col ${centeredOverlayHorizontalInsetClassName} ${desktopMaxWidthClassName} -translate-x-1/2 -translate-y-1/2 overflow-hidden ${overlaySurfaceRadiusClassName} border-[1px] border-white bg-card text-[13px] leading-5 text-foreground shadow-lg outline-none motion-safe:animate-cloud-enter`
                    }
                >
                    {headerAction !== undefined && !defaultAppearance && (
                        <div className="absolute right-14 top-3">{headerAction}</div>
                    )}
                    {typeof children === "function" ? (
                        <ScrollArea
                            className="min-h-0 max-h-[calc(100dvh-2rem)] max-sm:flex-1"
                            viewportClassName={cn("max-h-[inherit] max-sm:h-full", dialogScrollPaddingClassName)}
                        >
                            {children(header)}
                        </ScrollArea>
                    ) : pinsChrome ? (
                        <>
                            {header}
                            {/* In flow so a short body sets the dialog height. min-h-0 lets this region shrink and scroll once the dialog hits its max height. Absolute fill collapsed the body to 0 because the dialog height is indefinite. */}
                            <div className="relative flex min-h-0 flex-col">
                                <div
                                    ref={bodyScrollRef}
                                    onScroll={syncBodyEdges}
                                    className={cn(
                                        "min-h-0 overflow-y-auto overscroll-contain px-6 [scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin]",
                                        footer === undefined && "pb-6",
                                    )}
                                >
                                    {children}
                                </div>
                                <div
                                    aria-hidden="true"
                                    className={cn(
                                        "pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-card to-card/0 transition-opacity duration-150 motion-reduce:transition-none",
                                        bodyEdges.top ? "opacity-100" : "opacity-0",
                                    )}
                                />
                                <div
                                    aria-hidden="true"
                                    className={cn(
                                        "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-card to-card/0 transition-opacity duration-150 motion-reduce:transition-none",
                                        bodyEdges.bottom ? "opacity-100" : "opacity-0",
                                    )}
                                />
                            </div>
                            {footer !== undefined ? <div className="shrink-0">{footer}</div> : null}
                        </>
                    ) : (
                        <ScrollArea
                            className="min-h-0 max-h-[calc(100dvh-2rem)] max-sm:flex-1"
                            viewportClassName={cn("max-h-[inherit] max-sm:h-full", dialogScrollPaddingClassName)}
                        >
                            {header}
                            {children}
                        </ScrollArea>
                    )}
                    {!defaultAppearance
                        ? closeButton(
                              surface
                                  ? `absolute top-3 right-2 text-morty-text-3 hover:bg-morty-fill-opacity-2 hover:text-foreground sm:top-5 sm:right-5 sm:size-9 ${mobileHeaderIconButtonBelowSmClassName} ${mobileSheetCloseButtonPositionClassName}`
                                  : "absolute right-6 top-6",
                          )
                        : null}
                </Primitive.Content>
            </Primitive.Portal>
        </Primitive.Root>
    );
}
