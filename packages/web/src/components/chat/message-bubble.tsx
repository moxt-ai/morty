import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MessageCopyButton } from "./message-copy-button.tsx";
import { ResponseCopyButton } from "./response-copy-button.tsx";

export function MessageBubble({
    speaker,
    children,
    copyText,
    status,
    "data-testid": testId,
}: {
    readonly speaker: "user" | "assistant";
    readonly children: ReactNode;
    readonly copyText?: string | undefined;
    readonly status?: ReactNode;
    readonly "data-testid"?: string | undefined;
}) {
    const messageCopyText = speaker === "user" ? (copyText ?? (typeof children === "string" ? children : null)) : null;
    return (
        <article
            data-testid={testId}
            aria-label={speaker === "user" ? "Your message" : "Agent response"}
            className={cn(
                // The copy button hangs below the bubble, outside this element's box, so the pointer would
                // leave `group/message` before reaching it and the button would vanish mid-travel. This strip
                // bridges the gap; the button is raised above it so the overlap cannot swallow its clicks.
                "group/message relative min-w-0 [overflow-wrap:anywhere]",
                messageCopyText !== null && "after:absolute after:inset-x-0 after:top-full after:h-2",
                speaker === "user"
                    ? "flex w-fit max-w-full flex-col gap-1.5 rounded-md bg-user-message-surface px-4 py-3 text-base leading-6 whitespace-pre-wrap text-foreground"
                    : "w-full min-w-0 text-base leading-6 text-foreground",
            )}
        >
            {children}
            {messageCopyText !== null && <MessageCopyButton text={messageCopyText} />}
            {speaker === "assistant" && copyText !== undefined && copyText.trim().length > 0 && (
                <ResponseCopyButton text={copyText} />
            )}
            {status !== undefined && (
                <span className="absolute top-1/2 right-full mr-1.5 flex -translate-y-1/2">{status}</span>
            )}
        </article>
    );
}
