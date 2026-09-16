import type { SessionConfigOption } from "@moxt-ai/mobius-protocol";
import type { MobiusBrowserClient } from "@moxt-ai/mobius-sdk/browser";
import { useEffect, useRef, useState } from "react";
import { Select } from "../../components/ui/option-select.tsx";
import type { BotChatApi, ChatWorkspace } from "../../services/chat/bot-chat-api.ts";

type Inventory =
    | { readonly kind: "loading" }
    | {
          readonly kind: "ready";
          readonly workspace: ChatWorkspace;
          readonly options: readonly SessionConfigOption[];
          readonly harness: string;
      }
    | { readonly kind: "failed"; readonly message: string };
type Change =
    | { readonly kind: "idle" }
    | { readonly kind: "configuration"; readonly configId: string; readonly value: string }
    | { readonly kind: "failed"; readonly message: string };

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
    const [inventory, setInventory] = useState<Inventory>({ kind: "loading" });
    const [change, setChange] = useState<Change>({ kind: "idle" });
    const operation = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const refresh = async () => {
            try {
                const workspace = await requests.workspace(botId, controller.signal);
                controller.signal.throwIfAborted();
                setInventory((current) => (current.kind === "ready" ? { ...current, workspace } : current));
                timer = setTimeout(() => void refresh(), 5000);
            } catch (cause) {
                if (!controller.signal.aborted) {
                    setInventory({
                        kind: "failed",
                        message: cause instanceof Error ? cause.message : "Agent settings are unavailable.",
                    });
                }
            }
        };
        const open = async () => {
            const [workspace, snapshot, configuration] = await Promise.all([
                requests.workspace(botId, controller.signal),
                client.session.read(controller.signal),
                client.configuration.read(controller.signal),
            ]);
            controller.signal.throwIfAborted();
            setInventory({
                kind: "ready",
                workspace,
                options: configuration.options,
                harness: `${snapshot.session.defaultBinding.runtimeId}:${snapshot.session.defaultBinding.agentRef}`,
            });
            timer = setTimeout(() => void refresh(), 5000);
        };
        void open().catch((cause: unknown) => {
            if (!controller.signal.aborted) {
                setInventory({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "Agent settings are unavailable.",
                });
            }
        });
        return () => {
            controller.abort();
            clearTimeout(timer);
            operation.current?.abort();
        };
    }, [botId, client, requests]);
    useEffect(() => {
        if (change.kind !== "configuration") {
            return;
        }
        if (inventory.kind === "ready") {
            const applied = inventory.options.some(
                (option) => option.id === change.configId && option.currentValue === change.value,
            );
            if (applied) {
                setChange({ kind: "idle" });
                return;
            }
        }
    }, [change, inventory]);
    useEffect(() => {
        if (change.kind !== "configuration") {
            return;
        }
        const timeout = setTimeout(
            () =>
                setChange({
                    kind: "failed",
                    message: "The agent has not confirmed this selection. Check that your local Runtime is running.",
                }),
            45000,
        );
        return () => clearTimeout(timeout);
    }, [change]);
    const select = async (value: string, configId: string) => {
        if (inventory.kind !== "ready" || disabled) {
            return;
        }
        operation.current?.abort();
        const controller = new AbortController();
        operation.current = controller;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
        setChange({ kind: "configuration", value, configId });
        try {
            await client.configuration.update(
                {
                    configId,
                    value,
                    valueType: "select",
                    booleanValue: false,
                    additionalDirectoryIds: [],
                    idempotencyKey: crypto.randomUUID(),
                },
                signal,
            );
            const updated = await client.configuration.read(signal);
            if (!controller.signal.aborted) {
                setInventory((current) =>
                    current.kind === "ready" ? { ...current, options: updated.options } : current,
                );
            }
        } catch (cause) {
            if (!controller.signal.aborted) {
                setChange({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "The selection could not be applied.",
                });
            }
        }
    };
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
        <div className="space-y-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Select
                    label="Harness"
                    value={inventory.harness}
                    disabled
                    options={inventory.workspace.agents.map((agent) => ({
                        value: `${agent.runtimeId}:${agent.agentRef}`,
                        label: `${agent.label} · ${agent.machineName}`,
                    }))}
                    onValueChange={() => {}}
                />
                <Select
                    label="Model"
                    value={model?.currentValue ?? ""}
                    disabled={disabled || busy || model === undefined}
                    options={model?.values.map((value) => ({ value: value.value, label: value.name })) ?? []}
                    onValueChange={(value) => {
                        if (model !== undefined) {
                            void select(value, model.id);
                        }
                    }}
                />
                <Select
                    label="Variant"
                    value={variant?.currentValue ?? ""}
                    disabled={disabled || busy || variant === undefined}
                    options={variant?.values.map((value) => ({ value: value.value, label: value.name })) ?? []}
                    onValueChange={(value) => {
                        if (variant !== undefined) {
                            void select(value, variant.id);
                        }
                    }}
                />
            </div>
            {busy && (
                <p role="status" className="text-xs text-muted-foreground">
                    Waiting for your agent to apply the selection…
                </p>
            )}
            <p className="text-xs text-muted-foreground">
                The harness is fixed for this conversation. Start a new conversation to choose another harness.
            </p>
            {model === undefined && (
                <p className="text-xs text-muted-foreground">
                    Model choices appear when your local agent reports its session settings.
                </p>
            )}
            {change.kind === "failed" && (
                <p role="alert" className="text-xs text-destructive">
                    {change.message}
                </p>
            )}
        </div>
    );
}
