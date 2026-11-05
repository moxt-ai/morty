import { type ReactNode, useRef } from "react";
import { SidebarAccessNoticeCarousel } from "./sidebar-access-notice-carousel.tsx";

function mergeAttachHandlers(
    ...handlers: readonly ((node: HTMLElement | null) => (() => void) | undefined)[]
): (node: HTMLElement | null) => (() => void) | undefined {
    return (node) => {
        if (node === null) {
            return;
        }
        const cleanups = handlers
            .map((handler) => handler(node))
            .filter((cleanup): cleanup is () => void => cleanup !== undefined);
        return () => {
            for (const cleanup of cleanups) {
                cleanup();
            }
        };
    };
}

/** Hosts sidebar access notices, keeps store attach lifetimes, and carousels multiple cards. */
export function SidebarAccessNoticeHost({
    attachAccess,
    attachLinkedDevices,
    children,
}: {
    readonly attachAccess: ((node: HTMLElement | null) => (() => void) | undefined) | null;
    readonly attachLinkedDevices: ((node: HTMLElement | null) => (() => void) | undefined) | null;
    readonly children: ReactNode;
}) {
    const cleanupRef = useRef<(() => void) | undefined>(undefined);
    const attach = mergeAttachHandlers(
        ...(attachLinkedDevices === null ? [] : [attachLinkedDevices]),
        ...(attachAccess === null ? [] : [attachAccess]),
    );

    return (
        <div
            className="relative z-30 w-full min-w-0 shrink-0"
            ref={(node) => {
                cleanupRef.current?.();
                cleanupRef.current = node === null ? undefined : attach(node);
            }}
        >
            <SidebarAccessNoticeCarousel>{children}</SidebarAccessNoticeCarousel>
        </div>
    );
}
