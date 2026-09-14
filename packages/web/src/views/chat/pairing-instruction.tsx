import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";

type State =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly url: string; readonly expiresAt: string }
    | { readonly kind: "failed"; readonly message: string };

export function PairingInstruction({
    requests,
}: {
    readonly requests: Pick<BotChatApi, "listBots" | "createPairingInstruction">;
}) {
    const [state, setState] = useState<State>({ kind: "loading" });
    const [revision, refresh] = useState(0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly issues a new one-time ticket.
    useEffect(() => {
        const controller = new AbortController();
        setState({ kind: "loading" });
        void (async () => {
            const bot = (await requests.listBots(controller.signal))[0];
            if (bot === undefined) {
                throw new Error("Your Bot is unavailable.");
            }
            const ticket = await requests.createPairingInstruction(bot.botId, controller.signal);
            controller.signal.throwIfAborted();
            setState({ kind: "ready", ...ticket });
        })().catch((cause: unknown) => {
            if (!controller.signal.aborted) {
                setState({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "Pairing is unavailable.",
                });
            }
        });
        return () => controller.abort();
    }, [requests, revision]);
    return (
        <div className="mt-5 space-y-3">
            <div className="flex items-center gap-2">
                {state.kind === "ready" ? (
                    <input
                        aria-label="Agent pairing instruction"
                        readOnly
                        value={`follow ${state.url}`}
                        onFocus={(event) => event.currentTarget.select()}
                        className="min-w-0 flex-1 rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                ) : (
                    <p role="status" className="flex-1">
                        {state.kind === "loading" ? "Preparing pairing instruction…" : state.message}
                    </p>
                )}
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Refresh pairing instruction"
                    title="Get a fresh pairing token"
                    disabled={state.kind === "loading"}
                    onClick={() => refresh((value) => value + 1)}
                >
                    <RefreshCw
                        aria-hidden="true"
                        className={state.kind === "loading" ? "animate-spin motion-reduce:animate-none" : undefined}
                    />
                </Button>
            </div>
            {state.kind === "ready" && (
                <p className="text-xs text-muted-foreground">
                    One-time instruction. Expires {new Date(state.expiresAt).toLocaleString()}. Return to this page
                    after your agent connects.
                </p>
            )}
        </div>
    );
}
