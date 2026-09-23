import { useEffect, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import type { SelectedBotPreference } from "../../services/bots/selected-bot-preference.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import { LocalAgentChat } from "./local-agent-chat.tsx";
import { PairingInstruction } from "./pairing-instruction.tsx";

type Requests = Pick<
    BotChatApi,
    | "listBots"
    | "createBot"
    | "deleteBot"
    | "workspace"
    | "waitForWorkspaceChange"
    | "createPairingInstruction"
    | "agentSettings"
    | "localRuntime"
    | "localSessions"
    | "createLocalSession"
    | "connectLocalRuntime"
>;

type HomeState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "ready"; readonly bots: readonly ManagedBot[]; readonly selected: ManagedBot };

function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : "The Bot is unavailable.";
}

export function BotChatHome({
    requests,
    selectedBotPreference,
}: {
    readonly requests: Requests;
    readonly selectedBotPreference: SelectedBotPreference;
}) {
    const [home, setHome] = useState<HomeState>({ kind: "loading" });
    const [connected, setConnected] = useState(false);
    const [pairingOpen, setPairingOpen] = useState(false);
    const [botName, setBotName] = useState("");
    const [operationError, setOperationError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        void requests
            .listBots(controller.signal)
            .then((bots) => {
                if (controller.signal.aborted) {
                    return;
                }
                const selected = bots.find((bot) => bot.botId === selectedBotPreference.read()) ?? bots[0];
                setHome(
                    selected === undefined
                        ? { kind: "failed", message: "Your Bot is unavailable." }
                        : { kind: "ready", bots, selected },
                );
            })
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    setHome({ kind: "failed", message: errorMessage(cause) });
                }
            });
        return () => controller.abort();
    }, [requests, selectedBotPreference]);

    const selectedId = home.kind === "ready" ? home.selected.botId : null;
    useEffect(() => {
        if (selectedId === null) {
            return;
        }
        const controller = new AbortController();
        const watch = async () => {
            while (!controller.signal.aborted) {
                try {
                    const workspace = await requests.workspace(selectedId, controller.signal);
                    controller.signal.throwIfAborted();
                    setOperationError(null);
                    if (workspace.status === "active") {
                        const configuration = await requests.localRuntime(selectedId, controller.signal);
                        controller.signal.throwIfAborted();
                        setConnected(
                            workspace.agents.some(
                                (agent) =>
                                    agent.runtimeId === configuration.runtimeId &&
                                    agent.agentRef === configuration.agentRef &&
                                    agent.online,
                            ),
                        );
                    } else {
                        setConnected(false);
                    }
                    await requests.waitForWorkspaceChange(selectedId, controller.signal);
                } catch (cause) {
                    if (controller.signal.aborted) {
                        return;
                    }
                    if (cause instanceof DOMException && cause.name === "TimeoutError") {
                        continue;
                    }
                    setConnected(false);
                    setOperationError(errorMessage(cause));
                    return;
                }
            }
        };
        void watch();
        return () => controller.abort();
    }, [requests, selectedId]);

    const selectBot = (botId: string) => {
        if (home.kind !== "ready") {
            return;
        }
        const selected = home.bots.find((bot) => bot.botId === botId);
        if (selected === undefined) {
            return;
        }
        selectedBotPreference.write(botId);
        setConnected(false);
        setHome({ ...home, selected });
    };
    const createBot = async () => {
        const name = botName.trim();
        if (name.length === 0 || name.length > 80 || busy) {
            return;
        }
        setBusy(true);
        setOperationError(null);
        try {
            const bot = await requests.createBot(name, AbortSignal.timeout(45_000));
            selectedBotPreference.write(bot.botId);
            setHome((current) =>
                current.kind === "ready"
                    ? { kind: "ready", bots: [...current.bots, bot], selected: bot }
                    : { kind: "ready", bots: [bot], selected: bot },
            );
            setBotName("");
            setPairingOpen(true);
        } catch (cause) {
            setOperationError(errorMessage(cause));
        } finally {
            setBusy(false);
        }
    };
    const removeBot = async () => {
        if (home.kind !== "ready" || home.bots.length < 2 || busy) {
            return;
        }
        setBusy(true);
        setOperationError(null);
        try {
            await requests.deleteBot(home.selected.botId, AbortSignal.timeout(45_000));
            const bots = home.bots.filter((bot) => bot.botId !== home.selected.botId);
            const selected = bots[0];
            if (selected === undefined) {
                throw new Error("Keep at least one Bot in your workspace.");
            }
            selectedBotPreference.write(selected.botId);
            setHome({ kind: "ready", bots, selected });
        } catch (cause) {
            setOperationError(errorMessage(cause));
        } finally {
            setBusy(false);
        }
    };

    if (home.kind !== "ready") {
        return (
            <main aria-label="Chat" className="grid min-h-screen place-items-center">
                <p role={home.kind === "failed" ? "alert" : "status"}>
                    {home.kind === "failed" ? home.message : "Loading Bots…"}
                </p>
            </main>
        );
    }
    return (
        <>
            {connected ? (
                <LocalAgentChat
                    key={home.selected.botId}
                    bot={home.selected}
                    bots={home.bots}
                    onSelectBot={selectBot}
                    requests={requests}
                />
            ) : (
                <main aria-label="Chat" className="grid min-h-screen place-items-center bg-background p-6">
                    <div className="w-full max-w-lg space-y-4 text-center">
                        <h1 className="text-2xl font-semibold">{home.selected.displayName}</h1>
                        <p className="text-muted-foreground">Connect a local Agent to start chatting.</p>
                        <Button onClick={() => setPairingOpen(true)}>Pair Agent</Button>
                    </div>
                </main>
            )}
            <div className="fixed bottom-4 right-4 flex gap-2 rounded-lg border bg-background p-2 shadow-md">
                <input
                    aria-label="New Bot name"
                    className="w-32 rounded border px-2 text-sm"
                    maxLength={80}
                    onChange={(event) => setBotName(event.target.value)}
                    value={botName}
                />
                <Button disabled={busy || botName.trim().length === 0} onClick={() => void createBot()}>
                    Add Bot
                </Button>
                {home.bots.length > 1 && (
                    <Button disabled={busy} onClick={() => void removeBot()} variant="outline">
                        Remove Bot
                    </Button>
                )}
                <Button onClick={() => setPairingOpen(true)} variant="outline">
                    Pair
                </Button>
            </div>
            {operationError !== null && (
                <p className="fixed bottom-20 right-4 bg-background p-2 text-destructive" role="alert">
                    {operationError}
                </p>
            )}
            {pairingOpen && (
                <Dialog
                    title="Connect Agent"
                    description="Paste this one-time instruction into your local Agent."
                    onClose={() => setPairingOpen(false)}
                >
                    <PairingInstruction botId={home.selected.botId} requests={requests} />
                </Dialog>
            )}
        </>
    );
}
