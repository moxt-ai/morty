import { type BotChatHomeStore, botConnectionStatus } from "./bot-chat-home-store.ts";
import { selectedConversationId } from "./conversation-selection-machine.ts";
import { type SessionTitles, sessionTitle } from "./session-titles-store.ts";

/** A selected conversation is never presented as a new draft while its remote read is pending. */
export function pendingConversationPresentation(
    home: BotChatHomeStore,
    titles: SessionTitles,
): {
    readonly title: string;
    readonly recovery: { readonly title: string; readonly description: string } | null;
} {
    const selection = home.selection;
    const id = selectedConversationId(selection);
    const title = selection.kind === "draft" ? "New session" : sessionTitle(titles, id, "Existing session");
    if (
        selection.kind === "draft" ||
        selection.kind === "ready" ||
        (selection.kind === "failed" && (selection.failure === "unavailable" || selection.failure === "agent-required"))
    ) {
        return { title, recovery: null };
    }
    const recoveryTitle = !home.networkAvailable
        ? "No network connection"
        : botConnectionStatus(home).kind === "disconnected"
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
                      description: "History is temporarily unavailable. It will load when the connection returns.",
                  },
    };
}
