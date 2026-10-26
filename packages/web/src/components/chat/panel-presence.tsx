import type { ReactNode } from "react";
import { usePanelPresence } from "./sidebar-panel-presence.ts";

export type PanelMotion = ReturnType<typeof usePanelPresence>;

/** Renders its children with an opening or closing panel's motion state. */
export function PanelPresence({
    open,
    children,
}: {
    readonly open: boolean;
    readonly children: (motion: PanelMotion) => ReactNode;
}) {
    return children(usePanelPresence(open));
}
