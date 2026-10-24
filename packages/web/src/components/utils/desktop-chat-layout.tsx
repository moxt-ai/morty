import type { ReactNode } from "react";
import { useDesktopChatLayout } from "./use-desktop-chat-layout.ts";

/** Renders its children for the desktop or the compact chat layout, following the viewport width. */
export function DesktopChatLayout({ children }: { readonly children: (desktop: boolean) => ReactNode }) {
    return children(useDesktopChatLayout());
}
