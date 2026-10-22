import { useEffect, useState } from "react";

// TEMP style-tuning preview: remove this module with preview branches in chat-configuration-menu.tsx and option-select.tsx.
export const AGENT_CONFIG_PREVIEW_STATES = ["menu-open", "menu-model-open", "menu-loading"] as const;

export type AgentConfigPreviewState = (typeof AGENT_CONFIG_PREVIEW_STATES)[number];

export function getAgentConfigPreviewState(searchParams: URLSearchParams): AgentConfigPreviewState | null {
    const value = searchParams.get("agentConfigPreview");
    if (value === null) {
        return null;
    }
    return AGENT_CONFIG_PREVIEW_STATES.find((state) => state === value) ?? null;
}

export function useAgentConfigPreviewState(): AgentConfigPreviewState | null {
    const [search, setSearch] = useState(() => window.location.search);
    useEffect(() => {
        const syncSearch = () => {
            setSearch(window.location.search);
        };
        window.addEventListener("popstate", syncSearch);
        return () => {
            window.removeEventListener("popstate", syncSearch);
        };
    }, []);
    return getAgentConfigPreviewState(new URLSearchParams(search));
}

export const AGENT_CONFIG_PREVIEW_STATE_LABELS: Record<AgentConfigPreviewState, string> = {
    "menu-open": "Configuration menu open",
    "menu-model-open": "Configuration menu open with Model select expanded",
    "menu-loading": "Configuration menu open while settings load",
};
