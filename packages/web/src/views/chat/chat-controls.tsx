import type { MobiusBrowserClient } from "@moxt-ai/mobius-sdk/browser";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { ChatConfigurationMenu } from "../../components/chat/chat-configuration-menu.tsx";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { createChatControlsStore } from "../../view-models/chat/chat-controls-store.ts";

export function ChatControls({
    botId,
    client,
    disabled,
    requests,
}: {
    readonly botId: string;
    readonly client: MobiusBrowserClient;
    readonly disabled: boolean;
    readonly requests: Pick<BotChatApi, "workspace">;
}) {
    const [store] = useState(() => createChatControlsStore(botId, client, requests));
    const viewModel = useStore(store);
    const { change, inventory } = viewModel;
    const lifetime = useRef(new AbortController());
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void viewModel.open(controller.signal);
        return () => controller.abort();
    }, [viewModel.open]);
    if (inventory.kind === "loading") {
        return (
            <p role="status" className="px-1 text-xs text-muted-foreground">
                Loading your agent settings…
            </p>
        );
    }
    if (inventory.kind === "failed") {
        return (
            <p role="alert" className="px-1 text-xs text-destructive">
                {inventory.message}
            </p>
        );
    }
    const busy = change.kind === "configuration";
    const model = inventory.options.find((option) => option.category === "model" && option.type !== "boolean");
    const variant = inventory.options.find(
        (option) =>
            (option.category === "thought_level" || option.category === "model_config") && option.type !== "boolean",
    );
    return (
        <div className="flex min-w-0 items-center gap-1">
            <ChatConfigurationMenu
                controls={[
                    {
                        disabled: true,
                        id: "harness",
                        label: "Harness",
                        onValueChange: () => {},
                        options: inventory.workspace.agents.map((agent) => ({
                            value: `${agent.runtimeId}:${agent.agentRef}`,
                            label: `${agent.label} · ${agent.machineName}`,
                        })),
                        value: inventory.harness,
                    },
                    {
                        disabled: disabled || busy || model === undefined,
                        id: "model",
                        label: "Model",
                        onValueChange: (value) => {
                            if (model !== undefined) {
                                void viewModel.select(value, model.id, disabled, lifetime.current.signal);
                            }
                        },
                        options: model?.values.map((value) => ({ value: value.value, label: value.name })) ?? [],
                        value: model?.currentValue ?? "",
                    },
                    {
                        disabled: disabled || busy || variant === undefined,
                        id: "variant",
                        label: "Variant",
                        onValueChange: (value) => {
                            if (variant !== undefined) {
                                void viewModel.select(value, variant.id, disabled, lifetime.current.signal);
                            }
                        },
                        options: variant?.values.map((value) => ({ value: value.value, label: value.name })) ?? [],
                        value: variant?.currentValue ?? "",
                    },
                ]}
            />
            {busy && <span className="sr-only">Waiting for your agent to apply the selection…</span>}
            <p className="sr-only">
                The harness is fixed for this conversation. Start a new conversation to choose another harness.
            </p>
            {model === undefined && (
                <p className="sr-only">Model choices appear when your local agent reports its session settings.</p>
            )}
            {change.kind === "failed" && (
                <p role="alert" className="sr-only">
                    {change.message}
                </p>
            )}
        </div>
    );
}
