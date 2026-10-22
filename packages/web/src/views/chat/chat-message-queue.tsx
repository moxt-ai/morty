import { CornerUpLeft, LoaderCircle, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { ScrollEdgeFade } from "../../components/utils/scroll-edge-fade.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { ChatQueuedMessage } from "../../view-models/chat/session-message-queue-store.ts";

function QueueAction({
    label,
    disabled,
    onClick,
    children,
}: {
    readonly children: ReactNode;
    readonly disabled: boolean;
    readonly label: string;
    readonly onClick: () => void;
}) {
    return (
        <button
            aria-label={label}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-copy-secondary outline-none hover:bg-black/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={disabled}
            onClick={onClick}
            title={label}
            type="button"
        >
            {children}
        </button>
    );
}

export function ChatMessageQueue({
    messages,
    steeringSupported,
    onDelete,
    onSteer,
}: {
    readonly messages: readonly ChatQueuedMessage[];
    readonly steeringSupported: boolean;
    readonly onDelete: (commandId: string) => void;
    readonly onSteer: (commandId: string) => void;
}) {
    if (messages.length === 0) {
        return null;
    }
    return (
        <section
            aria-label="Queued messages"
            aria-live="polite"
            className="mx-auto mt-5 -mb-3 w-full max-w-[976px] shrink-0 px-4"
        >
            <div className="overflow-hidden rounded-2xl border border-[#d7dcdf] bg-white shadow-[0_5px_18px_rgba(23,30,36,0.04)]">
                <div className="flex items-center justify-between border-b border-black/[0.055] px-4 py-2">
                    <span className="text-[11px] font-semibold tracking-[0.055em] text-copy-tertiary uppercase">
                        Queued messages
                    </span>
                    <span className="text-xs tabular-nums text-copy-tertiary">{messages.length.toString()}</span>
                </div>
                <ScrollEdgeFade
                    scrollElement="ol"
                    fadeFromClassName="from-white"
                    className="max-h-36 overflow-y-auto p-2"
                >
                    {messages.map((message) => {
                        const pending = message.kind !== "queued";
                        return (
                            <li
                                className="flex min-h-10 items-center gap-2 rounded-xl px-2 py-1"
                                data-testid={dataTestId.queuedMessage}
                                key={message.commandId}
                            >
                                <span
                                    className="min-w-0 flex-1 truncate text-sm text-copy-secondary"
                                    title={message.summary}
                                >
                                    {message.summary}
                                </span>
                                <QueueAction
                                    disabled={pending || !steeringSupported}
                                    label={`Steer queued message: ${message.summary}`}
                                    onClick={() => onSteer(message.commandId)}
                                >
                                    {message.kind === "steering" ? (
                                        <LoaderCircle
                                            aria-hidden="true"
                                            className="size-4 animate-spin motion-reduce:animate-none"
                                        />
                                    ) : (
                                        <CornerUpLeft aria-hidden="true" className="size-4" />
                                    )}
                                </QueueAction>
                                <QueueAction
                                    disabled={pending}
                                    label={`Delete queued message: ${message.summary}`}
                                    onClick={() => onDelete(message.commandId)}
                                >
                                    {message.kind === "deleting" ? (
                                        <LoaderCircle
                                            aria-hidden="true"
                                            className="size-4 animate-spin motion-reduce:animate-none"
                                        />
                                    ) : (
                                        <Trash2 aria-hidden="true" className="size-4" />
                                    )}
                                </QueueAction>
                            </li>
                        );
                    })}
                </ScrollEdgeFade>
            </div>
        </section>
    );
}
