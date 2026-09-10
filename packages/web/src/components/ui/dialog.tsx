import { Dialog as Primitive } from "radix-ui";
import { type ReactNode, useState } from "react";
import { Button } from "./cloud-button.tsx";

export function Dialog({
    title,
    description,
    onClose,
    busy = false,
    children,
}: {
    readonly title: string;
    readonly description: string;
    readonly onClose: () => void;
    readonly busy?: boolean;
    readonly children: ReactNode;
}) {
    const [returnFocus] = useState(() =>
        typeof document !== "undefined" && document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
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
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        returnFocus?.focus();
                    }}
                    className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-6 text-[13px] leading-5 text-foreground shadow-lg outline-none motion-safe:animate-cloud-enter"
                >
                    <header className="mb-5 pr-7">
                        <Primitive.Title className="text-base font-semibold tracking-tight">{title}</Primitive.Title>
                        <Primitive.Description className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
                            {description}
                        </Primitive.Description>
                    </header>
                    {children}
                    <Primitive.Close asChild>
                        <Button
                            disabled={busy}
                            variant="ghost"
                            size="icon"
                            aria-label="Close dialog"
                            className="absolute right-3 top-3"
                        >
                            <X aria-hidden="true" className="size-4" />
                        </Button>
                    </Primitive.Close>
                </Primitive.Content>
            </Primitive.Portal>
        </Primitive.Root>
    );
}

import { X } from "lucide-react";
