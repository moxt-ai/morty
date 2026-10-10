import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button } from "../../components/ui/cloud-button.tsx";
import { useToast } from "../../components/ui/toast.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { createPairingInstructionStore } from "../../view-models/chat/pairing-instruction-store.ts";

export function PairingInstruction({
    botId,
    disabled = false,
    requests,
}: {
    readonly botId: string;
    readonly disabled?: boolean;
    readonly requests: Pick<BotChatApi, "createPairingInstruction">;
}) {
    const [store] = useState(() => createPairingInstructionStore(botId, requests));
    const { copy, copyInstruction, load, resetCopy, state } = useStore(store);
    const [revision, refresh] = useState(0);
    const showToast = useToast();
    useEffect(() => {
        if (copy === "idle") {
            return;
        }
        showToast(
            copy === "copied"
                ? { title: "Copied", variant: "success" }
                : {
                      description: "Select the instruction and copy it manually.",
                      title: "Could not copy",
                      variant: "error",
                  },
        );
    }, [copy, showToast]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly issues a new one-time ticket.
    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load, revision]);
    return (
        <div className="mt-5 space-y-3">
            <div className="flex items-center gap-2">
                {state.kind === "ready" ? (
                    <input
                        aria-label="Agent pairing instruction"
                        data-testid={dataTestId.pairingInstruction}
                        disabled={disabled}
                        readOnly
                        value={`follow ${state.url}`}
                        onFocus={(event) => event.currentTarget.select()}
                        className="min-w-0 flex-1 rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs outline-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
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
                    disabled={disabled || state.kind !== "ready"}
                    onClick={() => {
                        if (disabled || state.kind !== "ready") {
                            return;
                        }
                        resetCopy();
                        void copyInstruction();
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
        </div>
    );
}
