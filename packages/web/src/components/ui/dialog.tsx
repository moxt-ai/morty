import { X } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import { type ReactNode, useState } from "react";
import { dataTestId } from "../../data-testid.ts";
import { Button } from "./cloud-button.tsx";

export function Dialog({
    title,
    description,
    onClose,
    busy = false,
    wide = false,
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
                    : `${setup ? "mb-0" : surface ? "mb-4" : "mb-5"} ${headerAction === undefined ? (surface ? "pr-10" : "pr-7") : "pr-16"}`
            }
        >
            <Primitive.Title
                className={
                    setup
                        ? "text-32 font-semibold tracking-[-0.035em]"
                        : surface
                          ? "py-3 font-inter text-16 font-semibold tracking-[-0.015em]"
                          : "text-16 font-semibold tracking-tight"
                }
            >
                {title}
            </Primitive.Title>
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
                            ? "max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[560px] overflow-hidden rounded-3xl border-[1px] border-white bg-card/90 p-8 shadow-module backdrop-blur sm:p-12 fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 overflow-y-auto outline-none motion-safe:animate-cloud-enter"
                            : surface
                              ? `fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${wide ? "max-w-5xl" : "max-w-lg"} -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[32px] border border-white bg-card/90 p-2 font-inter text-13 text-foreground shadow-module backdrop-blur outline-none motion-safe:animate-cloud-enter`
                              : `fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${wide ? "max-w-5xl" : "max-w-lg"} -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-6 text-[13px] leading-5 text-foreground shadow-lg outline-none motion-safe:animate-cloud-enter`
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
                                    ? "absolute top-4 right-4 text-morty-text-3 hover:bg-morty-fill-opacity-2 hover:text-foreground sm:top-5 sm:right-5"
                                    : "absolute right-3 top-3"
                            }
                        >
                            <X aria-hidden="true" className="size-4" />
                        </Button>
                    </Primitive.Close>
                </Primitive.Content>
            </Primitive.Portal>
        </Primitive.Root>
    );
}
