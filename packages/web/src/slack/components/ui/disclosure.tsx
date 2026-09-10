import { Collapsible } from "radix-ui";
import type { ReactNode } from "react";

export function Disclosure({
    label,
    children,
    onOpenChange,
    defaultOpen = false,
}: {
    readonly label: string;
    readonly children: ReactNode;
    readonly onOpenChange?: (open: boolean) => void;
    readonly defaultOpen?: boolean;
}) {
    return (
        <Collapsible.Root defaultOpen={defaultOpen} {...(onOpenChange === undefined ? {} : { onOpenChange })}>
            <Collapsible.Trigger className="group flex items-center gap-2 rounded-md py-1.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                <svg
                    aria-hidden="true"
                    className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                >
                    <path d="m9 5 7 7-7 7" />
                </svg>
                {label}
            </Collapsible.Trigger>
            <Collapsible.Content className="mt-2 rounded-lg border border-border bg-accent/30 p-3">
                {children}
            </Collapsible.Content>
        </Collapsible.Root>
    );
}
