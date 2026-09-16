import type { SessionConfigOption } from "@moxt-ai/mobius-protocol";
import { useEffect, useRef, useState } from "react";
import { Select } from "../../components/ui/option-select.tsx";
import type { BotChatApi, ChatDraftConfiguration, ChatWorkspace } from "../../services/chat/bot-chat-api.ts";

type Settings =
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly message: string }
    | {
          readonly kind: "ready";
          readonly workspace: ChatWorkspace;
          readonly bindingId: string;
          readonly options: readonly SessionConfigOption[];
      };

export function DraftChatControls({
    botId,
    requests,
    disabled,
    onSettings,
}: {
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "workspace" | "selectAgent" | "draftSettings">;
    readonly disabled: boolean;
    readonly onSettings: (settings: ChatDraftConfiguration | null) => void;
}) {
    const [settings, setSettings] = useState<Settings>({ kind: "loading" });
    const [selection, setSelection] = useState("");
    const [revision, retry] = useState(0);
    const operation = useRef<AbortController | null>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads harness settings.
    useEffect(() => {
        const controller = new AbortController();
        operation.current = controller;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        setSettings({ kind: "loading" });
        onSettings(null);
        const load = async () => {
            try {
                const workspace = await requests.workspace(botId, signal);
                const selected = workspace.selected;
                if (
                    selected === null ||
                    (selection !== "" && `${selected.runtimeId}:${selected.agentRef}` !== selection)
                ) {
                    signal.throwIfAborted();
                    timer = setTimeout(() => void load(), 1000);
                    return;
                }
                const result = await requests.draftSettings(botId, signal);
                signal.throwIfAborted();
                setSettings({ kind: "ready", workspace, ...result });
                const model = result.options.find((option) => option.category === "model" && option.type !== "boolean");
                if (model !== undefined) {
                    onSettings({
                        bindingId: result.bindingId,
                        configuration: {
                            additionalDirectoryIds: [],
                            booleanValue: false,
                            configId: model.id,
                            value: model.currentValue,
                            valueType: "select",
                        },
                    });
                }
            } catch (cause) {
                if (!controller.signal.aborted) {
                    setSettings({
                        kind: "failed",
                        message: cause instanceof Error ? cause.message : "Harness settings are unavailable.",
                    });
                }
            }
        };
        void load();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [botId, requests, selection, revision, onSettings]);

    const selectHarness = async (value: string) => {
        if (settings.kind !== "ready" || disabled) {
            return;
        }
        const agent = settings.workspace.agents.find(
            (item) => `${item.runtimeId}:${item.agentRef}` === value && item.online,
        );
        const controller = operation.current;
        if (agent === undefined || controller === null) {
            return;
        }
        setSettings({ kind: "loading" });
        onSettings(null);
        try {
            await requests.selectAgent(
                botId,
                {
                    runtimeId: agent.runtimeId,
                    agentRef: agent.agentRef,
                    workspaceRef: "default",
                    agentConfigRevision: 1,
                },
                AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
            );
            if (!controller.signal.aborted) {
                setSelection(value);
            }
        } catch (cause) {
            if (!controller.signal.aborted) {
                setSettings({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "The harness could not be selected.",
                });
            }
        }
    };
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
            <div className="flex min-w-0 items-center gap-1">
                <Select
                    compact
                    label="Harness"
                    value={selected === null ? "" : `${selected.runtimeId}:${selected.agentRef}`}
                    disabled={disabled}
                    options={settings.workspace.agents
                        .filter((agent) => agent.online)
                        .map((agent) => ({
                            value: `${agent.runtimeId}:${agent.agentRef}`,
                            label: `${agent.label} · ${agent.machineName}`,
                        }))}
                    onValueChange={(value) => void selectHarness(value)}
                />
                <Select
                    compact
                    label="Model"
                    value={model?.currentValue ?? ""}
                    disabled={disabled || model === undefined}
                    options={
                        model?.type !== "boolean"
                            ? (model?.values.map((value) => ({ value: value.value, label: value.name })) ?? [])
                            : []
                    }
                    onValueChange={(value) => {
                        if (model === undefined) {
                            return;
                        }
                        setSettings({
                            ...settings,
                            options: settings.options.map((option) =>
                                option.id === model.id ? { ...option, currentValue: value } : option,
                            ),
                        });
                        onSettings({
                            bindingId: settings.bindingId,
                            configuration: {
                                additionalDirectoryIds: [],
                                booleanValue: false,
                                configId: model.id,
                                value,
                                valueType: "select",
                            },
                        });
                    }}
                />
            </div>
            {model === undefined && <span className="sr-only">This harness has not reported any model choices.</span>}
        </div>
    );
}
