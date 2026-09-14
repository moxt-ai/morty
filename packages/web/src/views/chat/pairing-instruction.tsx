import { Check, Copy } from "lucide-react";
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
    const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
    useEffect(() => {
        if (copy === "idle") {
            return;
        }
        const timeout = window.setTimeout(() => setCopy("idle"), 3000);
        return () => window.clearTimeout(timeout);
    }, [copy]);
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
                    aria-label="Copy pairing instruction"
                    title="Copy pairing instruction"
                    disabled={state.kind !== "ready"}
                    onClick={() => {
                        if (state.kind !== "ready") {
                            return;
                        }
                        setCopy("idle");
                        if (navigator.clipboard === undefined) {
                            setCopy("failed");
                            return;
                        }
                        void navigator.clipboard.writeText(`follow ${state.url}`).then(
                            () => setCopy("copied"),
                            () => setCopy("failed"),
                        );
                    }}
                >
                    <Copy aria-hidden="true" className="size-4" />
                </Button>
            </div>
            {state.kind === "ready" && (
                <p className="text-xs text-muted-foreground">
                    One-time instruction. Expires {new Date(state.expiresAt).toLocaleString()}. Return to this page
                    after your agent connects.
                </p>
            )}
            <button
                type="button"
                className="cursor-pointer rounded-sm text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                title="Get a fresh pairing token"
                disabled={state.kind === "loading"}
                onClick={() => refresh((value) => value + 1)}
            >
                Refresh pairing instruction
            </button>
            {copy !== "idle" && (
                <div
                    role="status"
                    className="fixed bottom-6 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-background px-4 py-3 text-sm text-foreground shadow-lg"
                >
                    {copy === "copied" && <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />}
                    {copy === "copied" ? "Copied" : "Could not copy. Select the instruction and copy it manually."}
                </div>
            )}
        </div>
    );
}
