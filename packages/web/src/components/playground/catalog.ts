/**
 * Component library catalog. To show a new component: append an entry here,
 * then add a gallery with the same id in galleries.tsx.
 */
export const PLAYGROUND_ENTRIES = [
    {
        group: "Foundations",
        id: "color",
        source: "styles.css",
        summary: "Semantic colors used by every surface.",
        title: "Color",
    },
    {
        group: "Foundations",
        id: "type",
        source: "text.css",
        summary: "Type scale, weights, and the sans and mono families.",
        title: "Type",
    },
    {
        group: "Foundations",
        id: "radius",
        source: "styles.css",
        summary: "Corner radius steps and the module shadow.",
        title: "Radius",
    },
    {
        group: "Controls",
        id: "cloud-button",
        source: "components/ui/cloud-button.tsx",
        summary: "Product actions with default, lg, sm, and icon sizes.",
        title: "Cloud button",
    },
    {
        group: "Controls",
        id: "button",
        source: "components/ui/button.tsx",
        summary: "Compact button used by session interactions.",
        title: "Button",
    },
    {
        group: "Controls",
        id: "button-group",
        source: "components/ui/button-group.tsx",
        summary: "Stacked and horizontal gaps for 40, 36, 32, and 28px button groups.",
        title: "Button group",
    },
    {
        group: "Controls",
        id: "input",
        source: "components/ui/input.tsx",
        summary: "Single-line field with placeholder and disabled states.",
        title: "Input",
    },
    {
        group: "Controls",
        id: "textarea",
        source: "components/ui/textarea.tsx",
        summary: "Transparent multiline field meant to sit inside a composer.",
        title: "Textarea",
    },
    {
        group: "Controls",
        id: "auto-select-input",
        source: "components/ui/auto-select-input.tsx",
        summary: "Input that focuses and selects its value when it appears.",
        title: "Auto-select input",
    },
    {
        group: "Controls",
        id: "option-select",
        source: "components/ui/option-select.tsx",
        summary: "Labeled select with compact, searchable, and disabled forms.",
        title: "Option select",
    },
    {
        group: "Controls",
        id: "menu-select",
        source: "components/ui/select.tsx",
        summary: "Menu select with a grouped list.",
        title: "Menu select",
    },
    {
        group: "Controls",
        id: "link-button",
        source: "components/ui/link-button.tsx",
        summary: "A button that reads as part of a sentence.",
        title: "Link button",
    },
    {
        group: "Controls",
        id: "text-link",
        source: "components/ui/text-link.ts",
        summary: "Inline link or command text. Color alone marks the resting, hover, and pressed states.",
        title: "Text link",
    },
    {
        group: "Controls",
        id: "spinner",
        source: "components/ui/spinner.tsx",
        summary: "Status spinner. The label is announced, not shown as text.",
        title: "Spinner",
    },
    {
        group: "Surfaces",
        id: "card",
        source: "components/ui/card.tsx",
        summary: "Bordered surface for a grouped block of content.",
        title: "Card",
    },
    {
        group: "Surfaces",
        id: "alert",
        source: "components/ui/morty-alert.tsx",
        summary: "Frosted notice for error, warning, success, info, and a neutral status.",
        title: "Alert",
    },
    {
        group: "Surfaces",
        id: "navigation-card",
        source: "components/ui/navigation-card-link.tsx",
        summary: "Card link that shows a pending state while navigation loads.",
        title: "Navigation card",
    },
    {
        group: "Overlays",
        id: "dialog",
        source: "components/ui/dialog.tsx",
        summary: "Modal dialog in default, setup, surface, wide, and busy forms.",
        title: "Dialog",
    },
    {
        group: "Overlays",
        id: "execution-details-dialog",
        source: "components/chat/execution-details-dialog.tsx",
        summary: "Session execution summary. Desktop width is 480px; mobile is a bottom sheet.",
        title: "Execution details dialog",
    },
    {
        group: "Overlays",
        id: "popover",
        source: "components/ui/popover.tsx",
        summary: "Unstyled popover primitives. Callers supply the surface; use overlaySurfaceRadiusClassName (24px).",
        title: "Popover",
    },
    {
        group: "Overlays",
        id: "tooltip",
        source: "components/ui/morty-tooltip-content.tsx",
        summary: "Dark tooltip content.",
        title: "Tooltip",
    },
    {
        group: "Overlays",
        id: "toast",
        source: "components/ui/toast.tsx",
        summary: "Bottom-center notification for success and error.",
        title: "Toast",
    },
    {
        group: "Overlays",
        id: "copy-button",
        source: "components/ui/copy-to-clipboard-button.tsx",
        summary: "Icon-only copy control. Success and failure use the toast.",
        title: "Copy button",
    },
    {
        group: "Chat",
        id: "message",
        source: "components/chat/message-bubble.tsx",
        summary: "User bubble and assistant response, including the copy affordance.",
        title: "Message",
    },
    {
        group: "Chat",
        id: "composer-notice",
        source: "components/chat/connection-notice.tsx",
        summary:
            "Composer notice states: failure, failure with connection status, and informational connection states.",
        title: "Composer notice",
    },
    {
        group: "Chat",
        id: "tool-call",
        source: "components/chat/tools/tool-call-status.tsx",
        summary: "Tool step row for running, succeeded, failed, interrupted, and unknown.",
        title: "Tool call",
    },
    {
        group: "Chat",
        id: "working-indicator",
        source: "components/chat/working-indicator.tsx",
        summary: "Elapsed time while an agent turn is running.",
        title: "Working indicator",
    },
    {
        group: "Chat",
        id: "native-session-directory-placeholder",
        source: "components/chat/native-session-directory-placeholder.tsx",
        summary: "Centered empty state for native session lists and preview panes.",
        title: "Native session placeholder",
    },
    {
        group: "Chat",
        id: "session-agent-tabs",
        source: "components/chat/session-agent-tabs.tsx",
        summary: "Agent switcher that expands the selected harness and keeps the others icon-only.",
        title: "Session agent tabs",
    },
    {
        group: "Chat",
        id: "harness-mark",
        source: "components/chat/harness-mark.tsx",
        summary: "Brand marks for Claude, Codex, Pi, and an unknown harness.",
        title: "Harness mark",
    },
    {
        group: "Chat",
        id: "attempt-failure",
        source: "components/chat/attempt-failure.tsx",
        summary: "Failed response, including the approval command when one is required.",
        title: "Attempt failure",
    },
] as const;

export type PlaygroundEntry = (typeof PLAYGROUND_ENTRIES)[number];
export type PlaygroundEntryId = PlaygroundEntry["id"];
export type PlaygroundGroup = PlaygroundEntry["group"];

export function playgroundEntry(id: string): PlaygroundEntry | undefined {
    return PLAYGROUND_ENTRIES.find((entry) => entry.id === id);
}

export function playgroundGroups(entries: readonly PlaygroundEntry[]): readonly PlaygroundGroup[] {
    const groups: PlaygroundGroup[] = [];
    for (const entry of entries) {
        if (!groups.includes(entry.group)) {
            groups.push(entry.group);
        }
    }
    return groups;
}
