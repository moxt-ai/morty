import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { DataRegion } from "../../services/identity/anonymous-identity-api.ts";
import { createDataRegionStore } from "../../view-models/chat/data-region-store.ts";

const locations: readonly { readonly label: string; readonly value: DataRegion }[] = [
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

export function DataRegionSelector({
    onReplacementChange,
    projectId,
    replaceIdentity,
}: {
    readonly onReplacementChange: (replacing: boolean) => void;
    readonly projectId: string;
    readonly replaceIdentity: (location: DataRegion, signal: AbortSignal) => Promise<void>;
}) {
    const [store] = useState(() => createDataRegionStore(projectId, replaceIdentity));
    const { location, replacement, select } = useStore(store);
    const operation = useRef<AbortController | null>(null);
    useEffect(() => () => operation.current?.abort(), []);
    useLayoutEffect(() => {
        const replacing = replacement.kind === "replacing";
        onReplacementChange(replacing);
        return () => {
            if (replacing) {
                onReplacementChange(false);
            }
        };
    }, [onReplacementChange, replacement.kind]);

    return (
        <div className="mt-4 space-y-1.5">
            <label className="block text-xs font-medium text-foreground" htmlFor="data-region">
                Data region
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
                <SelectTrigger id="data-region" className="w-full" data-testid={dataTestId.dataRegion}>
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
                    ? "Moving Morty data to this region…"
                    : "Changing region resets Morty data before you connect an agent."}
            </p>
            {replacement.kind === "failed" && (
                <p role="alert" className="text-xs text-red-700">
                    {replacement.message}
                </p>
            )}
        </div>
    );
}
