import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";
import {
    type OverlayContentOpenAutoFocus,
    overlayMenuSeparatorClassName,
    overlaySurfacePanelClassName,
    overlaySurfaceRadiusClassName,
    overlayTriggerOffsetPx,
} from "./overlay-surface.ts";

export function Select(props: ComponentProps<typeof SelectPrimitive.Root>) {
    return <SelectPrimitive.Root data-slot="select" {...props} />;
}

export function SelectValue(props: ComponentProps<typeof SelectPrimitive.Value>) {
    return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

export function SelectGroup(props: ComponentProps<typeof SelectPrimitive.Group>) {
    return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
    return (
        <SelectPrimitive.Label
            className={cn("px-3 pt-1 pb-1 text-xs font-normal text-morty-text-3", className)}
            data-slot="select-label"
            {...props}
        />
    );
}

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
    return (
        <SelectPrimitive.Trigger
            className={cn(
                "inline-flex h-9 min-w-[136px] items-center justify-between gap-2 rounded-lg border-[0.5px] border-black/10 bg-white px-2.5 text-xs font-medium text-copy-secondary outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-background keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/70 disabled:cursor-not-allowed disabled:opacity-50",
                className,
            )}
            data-slot="select-trigger"
            {...props}
        >
            {children}
            <SelectPrimitive.Icon asChild>
                <ChevronDown className="size-3.5 text-muted-foreground" />
            </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
    );
}

export function SelectContent({
    className,
    children,
    onOpenAutoFocus,
    position = "popper",
    sideOffset = overlayTriggerOffsetPx,
    ...props
}: ComponentProps<typeof SelectPrimitive.Content> & OverlayContentOpenAutoFocus) {
    return (
        <SelectPrimitive.Portal>
            <SelectPrimitive.Content
                data-slot="select-content"
                {...({
                    ...props,
                    className: cn(
                        "relative z-50 max-h-72 min-w-[9rem] animate-cloud-enter overflow-hidden text-sm text-foreground outline-none motion-reduce:animate-none",
                        overlaySurfacePanelClassName,
                        overlaySurfaceRadiusClassName,
                        className,
                    ),
                    onOpenAutoFocus: (event: Event) => {
                        event.preventDefault();
                        onOpenAutoFocus?.(event);
                    },
                    position,
                    sideOffset,
                } satisfies ComponentProps<typeof SelectPrimitive.Content> & OverlayContentOpenAutoFocus)}
            >
                <SelectPrimitive.ScrollUpButton className="flex h-6 cursor-default items-center justify-center bg-background">
                    <ChevronUp className="size-3.5" />
                </SelectPrimitive.ScrollUpButton>
                <SelectPrimitive.Viewport
                    className={cn(
                        "p-1.5",
                        position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1",
                    )}
                >
                    {children}
                </SelectPrimitive.Viewport>
                <SelectPrimitive.ScrollDownButton className="flex h-6 cursor-default items-center justify-center bg-background">
                    <ChevronDown className="size-3.5" />
                </SelectPrimitive.ScrollDownButton>
            </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
    );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
    return (
        <SelectPrimitive.Item
            className={cn(
                "relative flex h-9 w-full cursor-pointer select-none items-center rounded-full pr-8 pl-3 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[disabled]:opacity-50",
                className,
            )}
            data-slot="select-item"
            {...props}
        >
            <span className="absolute right-2 flex size-4 items-center justify-center">
                <SelectPrimitive.ItemIndicator>
                    <Check className="size-3.5" />
                </SelectPrimitive.ItemIndicator>
            </span>
            <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        </SelectPrimitive.Item>
    );
}

export function SelectSeparator({ className, ...props }: ComponentProps<typeof SelectPrimitive.Separator>) {
    return (
        <SelectPrimitive.Separator
            className={cn("-mx-1.5 my-1.5", overlayMenuSeparatorClassName, className)}
            data-slot="select-separator"
            {...props}
        />
    );
}
