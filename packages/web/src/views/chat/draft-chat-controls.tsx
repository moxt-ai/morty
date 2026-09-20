import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { dataTestId } from "@/data-testid";
import { ChatConfigurationMenu } from "../../components/chat/chat-configuration-menu.tsx";
import { CwdSelector } from "../../components/chat/cwd-selector.tsx";
import type { BotChatApi, ChatDraftConfiguration } from "../../services/chat/bot-chat-api.ts";
import { createDraftControlsStore } from "../../view-models/chat/draft-controls-store.ts";

export function DraftChatControls({
    botId,
    requests,
    disabled,
    onSettings,
}: {
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "workspace" | "workspaceDirectory" | "selectAgent" | "agentSettings">;
    readonly disabled: boolean;
    readonly onSettings: (settings: ChatDraftConfiguration | null) => void;
}) {
    const [store] = useState(() => createDraftControlsStore(botId, requests, onSettings, window.localStorage));
    const viewModel = useStore(store);
    const { settings } = viewModel;
    const [revision, retry] = useState(0);
    const operation = useRef<AbortController | null>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads harness settings.
    useEffect(() => {
        const controller = new AbortController();
        operation.current = controller;
        void viewModel.load(controller.signal);
        return () => controller.abort();
    }, [revision, viewModel.load]);
    if (settings.kind === "loading") {
        return (
            <p role="status" className="text-xs text-muted-foreground">
                Loading harness and model settings…
            </p>
        );
    }
    if (settings.kind === "failed") {
        return (
            <div>
                <p role="alert">{settings.message}</p>
                <button type="button" onClick={() => retry((value) => value + 1)}>
                    Retry settings
                </button>
            </div>
        );
    }
    const selected = settings.workspace.selected;
    const model = settings.options.find((option) => option.category === "model" && option.type !== "boolean");
    return (
        <div className="flex min-w-0 items-center gap-1">
            <ChatConfigurationMenu
                controls={[
                    {
                        disabled,
                        id: "harness",
                        kind: "select" as const,
                        label: "Harness",
                        onValueChange: (value) => {
                            const controller = operation.current;
                            if (controller !== null) {
                                void viewModel.selectHarness(value, disabled, controller.signal);
                            }
                        },
                        options: settings.workspace.agents
                            .filter((agent) => agent.online)
                            .map((agent) => ({
                                value: `${agent.runtimeId}:${agent.agentRef}`,
                                label: `${agent.label} · ${agent.machineName}`,
                            })),
                        value: selected === null ? "" : `${selected.runtimeId}:${selected.agentRef}`,
                    },
                    ...settings.options.map((option) =>
                        option.type === "boolean"
                            ? {
                                  checked: option.booleanValue,
                                  disabled,
                                  id: option.id,
                                  kind: "boolean" as const,
                                  label: option.name,
                                  onCheckedChange: () => viewModel.toggleOption(option.id),
                                  testId: dataTestId.agentSetting(option.id),
                              }
                            : {
                                  disabled,
                                  id: option.id,
                                  kind: "select" as const,
                                  label: option.name,
                                  onValueChange: (value: string) => viewModel.selectOption(option.id, value),
                                  options: option.values.map((value) => ({ value: value.value, label: value.name })),
                                  testId: dataTestId.agentSetting(option.id),
                                  value: option.currentValue,
                              },
                    ),
                ]}
            />
            <CwdSelector
                disabled={disabled}
                signal={operation.current?.signal ?? AbortSignal.abort()}
                viewModel={viewModel}
            />
            {model === undefined && <span className="sr-only">This harness has not reported any model choices.</span>}
        </div>
    );
}
