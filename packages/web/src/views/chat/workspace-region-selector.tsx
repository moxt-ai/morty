import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { WorkspaceLocation } from "../../services/identity/anonymous-identity-api.ts";
import { createWorkspaceRegionStore } from "../../view-models/chat/workspace-region-store.ts";

const locations: readonly { readonly label: string; readonly value: WorkspaceLocation }[] = [
    { label: "Western North America", value: "wnam" },
    { label: "Eastern North America", value: "enam" },
    { label: "South America", value: "sam" },
    { label: "Western Europe", value: "weur" },
    { label: "Eastern Europe", value: "eeur" },
    { label: "Asia Pacific", value: "apac" },
    { label: "Northeast Asia", value: "apac-ne" },
    { label: "Southeast Asia", value: "apac-se" },
    { label: "Oceania", value: "oc" },
    { label: "Africa", value: "afr" },
    { label: "Middle East", value: "me" },
];

export function WorkspaceRegionSelector({
    projectId,
    replaceWorkspace,
}: {
    readonly projectId: string;
    readonly replaceWorkspace: (location: WorkspaceLocation, signal: AbortSignal) => Promise<void>;
}) {
    const [store] = useState(() => createWorkspaceRegionStore(projectId, replaceWorkspace));
    const { location, replacement, select } = useStore(store);
    const operation = useRef<AbortController | null>(null);
    useEffect(() => () => operation.current?.abort(), []);

    return (
        <div className="mt-4 space-y-1.5">
            <label className="block text-xs font-medium text-foreground" htmlFor="workspace-region">
                Workspace region
            </label>
            <Select
                disabled={replacement.kind === "replacing"}
                value={location}
                onValueChange={(value) => {
                    const selected = locations.find((option) => option.value === value);
                    if (selected === undefined) {
                        return;
                    }
                    operation.current?.abort();
                    const controller = new AbortController();
                    operation.current = controller;
                    void select(selected.value, controller.signal);
                }}
            >
                <SelectTrigger id="workspace-region" className="w-full" data-testid={dataTestId.workspaceRegion}>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {locations.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                            {option.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
                {replacement.kind === "replacing"
                    ? "Creating a fresh workspace in this region…"
                    : "Changing region replaces this fresh workspace before you connect an agent."}
            </p>
            {replacement.kind === "failed" && (
                <p role="alert" className="text-xs text-red-700">
                    {replacement.message}
                </p>
            )}
        </div>
    );
}
