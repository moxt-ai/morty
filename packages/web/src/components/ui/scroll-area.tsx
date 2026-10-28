import { ScrollArea as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type ScrollAreaProps = ComponentProps<typeof Primitive.Root> & {
    readonly viewportClassName?: string;
    readonly viewportRef?: ComponentProps<typeof Primitive.Viewport>["ref"];
    readonly viewportStyle?: ComponentProps<typeof Primitive.Viewport>["style"];
};

export function ScrollArea({
    children,
    className,
    viewportClassName,
    viewportRef,
    viewportStyle,
    ...props
}: ScrollAreaProps) {
    return (
        <Primitive.Root className={cn("relative overflow-hidden", className)} data-slot="scroll-area" {...props}>
            <Primitive.Viewport
                className={cn("w-full rounded-[inherit]", viewportClassName)}
                data-slot="scroll-area-viewport"
                ref={viewportRef}
                style={viewportStyle}
            >
                {children}
            </Primitive.Viewport>
            <ScrollBar />
            <Primitive.Corner className="bg-transparent" />
        </Primitive.Root>
    );
}

function ScrollBar({ className, orientation = "vertical", ...props }: ComponentProps<typeof Primitive.Scrollbar>) {
    return (
        <Primitive.Scrollbar
            className={cn(
                "flex touch-none select-none p-px transition-colors duration-150 motion-reduce:transition-none",
                orientation === "vertical" ? "h-full w-2" : "h-2 w-full flex-col",
                className,
            )}
            data-slot="scroll-area-scrollbar"
            orientation={orientation}
            {...props}
        >
            <Primitive.Thumb
                className="relative flex-1 rounded-full bg-[#d4d7db] hover:bg-morty-text-4"
                data-slot="scroll-area-thumb"
            />
        </Primitive.Scrollbar>
    );
}
