import { Popover as Primitive } from "radix-ui";
import type { ComponentProps } from "react";
import { overlayTriggerOffsetPx } from "./overlay-surface.ts";

export const Popover = {
    Arrow: (props: ComponentProps<typeof Primitive.Arrow>) => <Primitive.Arrow {...props} />,
    Content: ({
        onOpenAutoFocus,
        role,
        sideOffset = overlayTriggerOffsetPx,
        ...props
    }: ComponentProps<typeof Primitive.Content>) => (
        <Primitive.Content
            onOpenAutoFocus={(event) => {
                onOpenAutoFocus?.(event);
                if (role === "menu" && !event.defaultPrevented) {
                    event.preventDefault();
                }
            }}
            role={role}
            sideOffset={sideOffset}
            {...props}
        />
    ),
    Portal: (props: ComponentProps<typeof Primitive.Portal>) => <Primitive.Portal {...props} />,
    Root: (props: ComponentProps<typeof Primitive.Root>) => <Primitive.Root {...props} />,
    Trigger: (props: ComponentProps<typeof Primitive.Trigger>) => <Primitive.Trigger {...props} />,
};
