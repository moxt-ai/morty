import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MessageCopyButton } from "./message-copy-button.tsx";

export function MessageBubble({
    speaker,
    children,
    copyText,
    "data-testid": testId,
}: {
    readonly speaker: "user" | "assistant";
    readonly children: ReactNode;
    readonly copyText?: string;
    readonly "data-testid"?: string | undefined;
}) {
    const messageCopyText = speaker === "user" ? (copyText ?? (typeof children === "string" ? children : null)) : null;
    return (
        <article
            data-testid={testId}
            aria-label={speaker === "user" ? "Your message" : "Agent response"}
            className={cn(
                "group/message relative min-w-0 text-[15px] leading-[1.75] [overflow-wrap:anywhere]",
                speaker === "user"
                    ? "ml-auto w-fit max-w-[88%] rounded-[20px] bg-[#f4f4f5] px-4 py-2.5 whitespace-pre-wrap text-foreground sm:max-w-[82%] sm:px-5 sm:py-3"
                    : "mr-4 text-foreground sm:mr-8 sm:px-2",
            )}
        >
            {children}
            {messageCopyText !== null && <MessageCopyButton text={messageCopyText} />}
        </article>
    );
}
