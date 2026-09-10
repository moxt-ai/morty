import { Popover as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

export const Popover = {
    Arrow: (props: ComponentProps<typeof Primitive.Arrow>) => <Primitive.Arrow {...props} />,
    Content: (props: ComponentProps<typeof Primitive.Content>) => <Primitive.Content {...props} />,
    Portal: (props: ComponentProps<typeof Primitive.Portal>) => <Primitive.Portal {...props} />,
    Root: (props: ComponentProps<typeof Primitive.Root>) => <Primitive.Root {...props} />,
    Trigger: (props: ComponentProps<typeof Primitive.Trigger>) => <Primitive.Trigger {...props} />,
};
