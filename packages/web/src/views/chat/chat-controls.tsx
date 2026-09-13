import type { SessionConfigOption } from "@moxt-ai/mobius-protocol";
import type { MobiusBrowserClient, MobiusClient } from "@moxt-ai/mobius-sdk/browser";
import { useEffect, useRef, useState } from "react";
import { Select } from "../../components/ui/option-select.tsx";
import type { BotChatApi, ChatWorkspace } from "../../services/chat/bot-chat-api.ts";

type Inventory =
    | { readonly kind: "loading" }
    | {
          readonly kind: "ready";
          readonly workspace: ChatWorkspace;
          readonly options: readonly SessionConfigOption[];
          readonly sessionClient: MobiusClient;
          readonly sessionId: string;
      }
    | { readonly kind: "failed"; readonly message: string };
type Change =
    | { readonly kind: "idle" }
    | { readonly kind: "agent"; readonly value: string }
    | { readonly kind: "configuration"; readonly configId: string; readonly value: string }
    | { readonly kind: "failed"; readonly message: string };

export function ChatControls({
    botId,
    client,
    requests,
    onAgentChanged,
}: {
    readonly botId: string;
    readonly client: MobiusBrowserClient;
    readonly requests: Pick<BotChatApi, "workspace" | "selectAgent" | "connectSession">;
    readonly onAgentChanged: () => void;
}) {
    const [inventory, setInventory] = useState<Inventory>({ kind: "loading" });
    const [change, setChange] = useState<Change>({ kind: "idle" });
    const operation = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let sessionClient: MobiusClient | null = null;
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
            const [workspace, snapshot] = await Promise.all([
                requests.workspace(botId, controller.signal),
                client.session.read(controller.signal),
            ]);
            const selected = workspace.selected;
            if (selected === null) {
                throw new Error("Choose a connected local agent.");
            }
            sessionClient = await requests.connectSession(botId, snapshot.session.sessionId, controller.signal);
            controller.signal.throwIfAborted();
            const ready = await sessionClient.sessions.prepare(snapshot.session.sessionId, controller.signal);
            controller.signal.throwIfAborted();
            setInventory({
                kind: "ready",
                workspace,
                options: ready.configOptions,
                sessionClient,
                sessionId: snapshot.session.sessionId,
            });
            timer = setTimeout(() => void refresh(), 5000);
        };
        void open().catch((cause: unknown) => {
            sessionClient?.close();
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
            sessionClient?.close();
        };
    }, [botId, client, requests]);
    useEffect(() => {
        if (change.kind !== "agent" && change.kind !== "configuration") {
            return;
        }
        if (inventory.kind === "ready") {
            const applied =
                change.kind === "agent"
                    ? inventory.workspace.selected !== null &&
                      `${inventory.workspace.selected.runtimeId}:${inventory.workspace.selected.agentRef}` ===
                          change.value
                    : inventory.options.some(
                          (option) => option.id === change.configId && option.currentValue === change.value,
                      );
            if (applied) {
                setChange({ kind: "idle" });
                if (change.kind === "agent") {
                    onAgentChanged();
                }
                return;
            }
        }
    }, [change, inventory, onAgentChanged]);
    useEffect(() => {
        if (change.kind !== "agent" && change.kind !== "configuration") {
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
    const select = async (kind: "agent" | "configuration", value: string, configId = "") => {
        if (inventory.kind !== "ready") {
            return;
        }
        operation.current?.abort();
        const controller = new AbortController();
        operation.current = controller;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
        setChange(kind === "agent" ? { kind, value } : { kind, value, configId });
        try {
            if (kind === "agent") {
                const agent = inventory.workspace.agents.find(
                    (candidate) => `${candidate.runtimeId}:${candidate.agentRef}` === value && candidate.online,
                );
                if (agent === undefined) {
                    throw new Error("Select a connected local agent.");
                }
                await requests.selectAgent(
                    botId,
                    {
                        runtimeId: agent.runtimeId,
                        agentRef: agent.agentRef,
                        workspaceRef: "default",
                        agentConfigRevision: 1,
                    },
                    signal,
                );
            } else {
                const selected = inventory.workspace.selected;
                if (selected === null) {
                    throw new Error("Your selected agent is unavailable.");
                }
                const updated = await inventory.sessionClient.sessions.updateConfiguration(
                    inventory.sessionId,
                    {
                        configId,
                        value,
                        valueType: "select",
                        booleanValue: false,
                    },
                    signal,
                );
                if (!controller.signal.aborted) {
                    setInventory((current) =>
                        current.kind === "ready" ? { ...current, options: updated.configOptions } : current,
                    );
                }
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
    const busy = change.kind === "agent" || change.kind === "configuration";
    const selected = inventory.workspace.selected;
    const model = inventory.options.find((option) => option.category === "model" && option.type !== "boolean");
    const variant = inventory.options.find(
        (option) =>
            (option.category === "thought_level" || option.category === "model_config") && option.type !== "boolean",
    );
    return (
        <div className="space-y-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Select
                    label="Local agent"
                    value={selected === null ? "" : `${selected.runtimeId}:${selected.agentRef}`}
                    disabled={busy}
                    options={inventory.workspace.agents
                        .filter((agent) => agent.online)
                        .map((agent) => ({
                            value: `${agent.runtimeId}:${agent.agentRef}`,
                            label: `${agent.label} · ${agent.machineName}`,
                        }))}
                    onValueChange={(value) => void select("agent", value)}
                />
                <Select
                    label="Model"
                    value={model?.currentValue ?? ""}
                    disabled={busy || model === undefined}
                    options={model?.values.map((value) => ({ value: value.value, label: value.name })) ?? []}
                    onValueChange={(value) => {
                        if (model !== undefined) {
                            void select("configuration", value, model.id);
                        }
                    }}
                />
                <Select
                    label="Variant"
                    value={variant?.currentValue ?? ""}
                    disabled={busy || variant === undefined}
                    options={variant?.values.map((value) => ({ value: value.value, label: value.name })) ?? []}
                    onValueChange={(value) => {
                        if (variant !== undefined) {
                            void select("configuration", value, variant.id);
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
                Changing the local agent starts a new Bot conversation. Earlier sessions remain in the sidebar.
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
