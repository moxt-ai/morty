import { CircleAlert, CircleHelp, RefreshCw } from "lucide-react";
import { Tooltip } from "radix-ui";
import { useStore } from "zustand";
import { dataTestId } from "@/data-testid";
import { ChatConfigurationMenu } from "../../components/chat/chat-configuration-menu.tsx";
import { CwdSelector } from "../../components/chat/cwd-selector.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { type BotChatApi, connectedChatRuntimeAgents } from "../../services/chat/bot-chat-api.ts";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";

export function DraftChatControls({
    workspace,
    botId: _botId,
    requests: _requests,
    disabled,
}: {
    readonly workspace: ChatWorkspace;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "runtimeConfiguration" | "directory" | "agentSettings">;
    readonly disabled: boolean;
}) {
    const viewModel = useStore(workspace.draftControls);
    const signal = workspace.chatSignal();
    const { settings } = viewModel;
    const retry = () => {
        workspace.retryDraftControls();
    };
    if (settings.kind === "loading") {
        return <Spinner label="Loading harness and model settings" />;
    }
    if (settings.kind === "failed") {
        return (
            <div className="flex min-w-0 items-center gap-1">
                <span className="sr-only" role="alert">
                    {settings.message}
                </span>
                <button
                    className="flex h-9 min-w-0 max-w-48 items-center gap-1.5 rounded-lg px-2 text-[13px] text-destructive outline-none transition-colors hover:bg-destructive/8 focus-visible:ring-2 focus-visible:ring-destructive/30 motion-reduce:transition-none"
                    onClick={retry}
                    type="button"
                >
                    <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
                    <span className="truncate">Retry settings</span>
                    <RefreshCw aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
                </button>
                <Tooltip.Provider delayDuration={150}>
                    <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                            <button
                                aria-label="Why settings are unavailable"
                                className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
                                type="button"
                            >
                                <CircleHelp aria-hidden="true" className="size-4" />
                            </button>
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                            <Tooltip.Content
                                className="z-[70] max-w-80 rounded-lg bg-foreground px-3 py-2 text-xs leading-5 text-background shadow-lg"
                                side="top"
                                sideOffset={8}
                            >
                                {settings.message}
                                <Tooltip.Arrow className="fill-foreground" />
                            </Tooltip.Content>
                        </Tooltip.Portal>
                    </Tooltip.Root>
                </Tooltip.Provider>
            </div>
        );
    }
    const switching = settings.kind === "switching";
    const settingsLoading = switching || settings.kind === "refreshing";
    const selectedHarness = switching
        ? settings.selectedHarness
        : `${settings.selectedAgent.runtimeId}:${settings.selectedAgent.agentRef}`;
    const options = settings.kind === "ready" ? settings.options : [];
    const model = options.find((option) => option.category === "model" && option.type !== "boolean");
    return (
        <div className="flex min-w-0 items-center gap-1">
            <ChatConfigurationMenu
                controls={[
                    {
                        disabled: disabled || settingsLoading,
                        id: "harness",
                        kind: "select" as const,
                        label: "Harness",
                        onValueChange: (value) => {
                            void viewModel.selectHarness(value, disabled, signal);
                        },
                        options: connectedChatRuntimeAgents(settings.configuration.runtime).map((agent) => ({
                            agentRef: agent.agentRef,
                            value: `${agent.runtimeId}:${agent.agentRef}`,
                            label: agent.label,
                            tabLabel: agent.label,
                        })),
                        value: selectedHarness,
                    },
                    ...options.map((option) =>
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
                                  searchable: option.category === "model",
                                  testId: dataTestId.agentSetting(option.id),
                                  value: option.currentValue,
                              },
                    ),
                ]}
                settingsLoading={settingsLoading}
            />
            <CwdSelector disabled={disabled || settingsLoading} signal={signal} viewModel={viewModel} />
            {!switching && model === undefined && (
                <span className="sr-only">This harness has not reported any model choices.</span>
            )}
        </div>
    );
}
