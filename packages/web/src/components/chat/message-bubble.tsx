import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function MessageBubble({
    speaker,
    children,
    "data-testid": testId,
}: {
    readonly speaker: "user" | "assistant";
    readonly children: ReactNode;
    readonly "data-testid"?: string;
}) {
    return (
        <article
            data-testid={testId}
            aria-label={speaker === "user" ? "Your message" : "Agent response"}
            className={cn(
                "min-w-0 border text-sm leading-[1.8] [overflow-wrap:anywhere]",
                speaker === "user"
                    ? "ml-auto w-fit max-w-[88%] rounded-[22px] rounded-br-md border-[#196844] bg-[#216c4b] px-4 py-3 whitespace-pre-wrap text-white shadow-[0_3px_8px_rgb(24_79_54/10%)] sm:max-w-[82%] sm:px-5 sm:py-3.5"
                    : "mr-4 rounded-[22px] rounded-tl-md border-[#e0e7e2] bg-white p-4 text-foreground shadow-[0_2px_5px_rgb(24_49_35/3%)] sm:mr-8 sm:px-6 sm:py-5",
            )}
        >
            {children}
        </article>
    );
}
