import type { BotChatHomeStore } from "./bot-chat-home-store.ts";
import { selectedConversationId } from "./conversation-selection-machine.ts";

const SAVED_HISTORY_NOTICE = "Your conversation is saved on your computer. History will load when it reconnects.";

/** A selected conversation is never presented as a new draft while its remote read is pending. */
export function pendingConversationPresentation(home: BotChatHomeStore): {
    readonly title: string;
    readonly recovery: { readonly title: string; readonly description: string } | null;
} {
    const selection = home.selection;
    const id = selectedConversationId(selection);
    const title =
        selection.kind === "draft"
            ? "New session"
            : home.rememberedSession?.id === id
              ? home.rememberedSession.title
              : "Existing session";
    if (
        selection.kind === "draft" ||
        selection.kind === "ready" ||
        selection.target.kind === "continue" ||
        (selection.kind === "failed" && selection.failure === "unavailable")
    ) {
        return { title, recovery: null };
    }
    const recoveryTitle = !home.networkAvailable
        ? "No network connection"
        : home.view.kind === "runtime-disconnected"
          ? "Computer is offline"
          : home.configurationWatch.kind === "unavailable" || selection.kind === "failed"
            ? "Connection interrupted"
            : null;
    return {
        title,
        recovery:
            recoveryTitle === null
                ? null
                : {
                      title: recoveryTitle,
                      description:
                          home.rememberedSession?.id === id
                              ? SAVED_HISTORY_NOTICE
                              : "History is temporarily unavailable. It will load when the connection returns.",
                  },
    };
}
