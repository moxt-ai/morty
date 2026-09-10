import { Dialog as Primitive } from "radix-ui";
import { type ReactNode, useState } from "react";

export function Dialog({
    title,
    description,
    onClose,
    children,
}: {
    readonly title: string;
    readonly description: string;
    readonly onClose: () => void;
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
                if (!open) {
                    onClose();
                }
            }}
        >
            <Primitive.Portal>
                <Primitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
                <Primitive.Content
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        returnFocus?.focus();
                    }}
                    className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-6 text-[13px] leading-5 text-foreground shadow-xl outline-none [&_input]:h-9 [&_input]:text-[13px] [&_label]:text-xs [&_label]:font-medium [&_textarea]:w-full [&_textarea]:rounded-md [&_textarea]:border [&_textarea]:border-border [&_textarea]:bg-background [&_textarea]:p-3 [&_textarea]:text-[13px] [&_textarea]:leading-5"
                >
                    <header className="mb-5 pr-7">
                        <Primitive.Title className="text-base font-semibold tracking-tight">{title}</Primitive.Title>
                        <Primitive.Description className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
                            {description}
                        </Primitive.Description>
                    </header>
                    <Primitive.Close
                        aria-label="Close dialog"
                        className="absolute right-4 top-4 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    >
                        <svg
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            className="size-4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                        >
                            <path d="m6 6 12 12M6 18 18 6" />
                        </svg>
                    </Primitive.Close>
                    {children}
                </Primitive.Content>
            </Primitive.Portal>
        </Primitive.Root>
    );
}
