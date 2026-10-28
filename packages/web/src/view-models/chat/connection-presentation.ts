import type { ConnectionFeedback, ExecutionContext } from "../../components/chat/execution-context.ts";
import { type BotChatHomeStore, botConnectionStatus } from "./bot-chat-home-store.ts";
import type { SessionConnection } from "./session-connection.ts";

type ConnectionPresentation = Pick<
    ExecutionContext,
    "computerStatus" | "lastConfirmed" | "connection" | "indicator" | "feedback" | "available"
>;

/** One projection for the header, details and composer; none infer availability independently. */
export function connectionPresentation(
    home: BotChatHomeStore,
    session: SessionConnection | null,
): ConnectionPresentation {
    const computer = botConnectionStatus(home);
    const computerStatus =
        computer.kind === "connected"
            ? "Online"
            : computer.kind === "disconnected"
              ? "Offline"
              : computer.kind === "unpaired"
                ? "Not paired"
                : computer.kind === "connecting"
                  ? "Checking availability"
                  : "Status unavailable";
    const watch = home.configurationWatch;
    const checkedAt =
        watch.kind === "current" ? watch.checkedAt : watch.kind === "unavailable" ? watch.lastCheckedAt : null;
    const lastConfirmed =
        (!home.networkAvailable || watch.kind === "unavailable") &&
        checkedAt !== null &&
        home.runtimeConfiguration !== null
            ? `Last confirmed ${home.runtimeConfiguration.runtime.online ? "online" : "offline"} at ${new Date(checkedAt).toLocaleTimeString()}`
            : null;
    const connection = sessionLabel(session, home.selection.kind === "draft");
    const present = (
        indicator: ExecutionContext["indicator"],
        feedback: ConnectionFeedback,
    ): ConnectionPresentation => ({
        computerStatus,
        lastConfirmed,
        connection,
        indicator,
        // Presence can change before the Session stream settles. Keep availability conservative, but let
        // the Session's own recovery lifecycle decide when an interruption needs a composer notice.
        feedback:
            session?.kind === "ready" && home.networkAvailable && computer.kind !== "unpaired"
                ? { kind: "hidden" }
                : feedback,
        available: indicator.kind === "ready",
    });
    if (session?.kind === "closed") {
        return present(
            { kind: "closed", label: "Session closed" },
            {
                kind: "closed",
                description:
                    session.reopen.kind === "failed"
                        ? session.reopen.message
                        : !home.networkAvailable
                          ? "Reconnect to the network before reopening this session."
                          : (session.reason ?? "Reopen it to continue this conversation."),
                reopen:
                    session.reopen.kind === "reopening"
                        ? "reopening"
                        : !home.networkAvailable
                          ? "offline"
                          : session.reopen.kind,
            },
        );
    }
    if (!home.networkAvailable) {
        return present(
            { kind: "offline", label: "No network connection" },
            {
                kind: "waiting",
                title: "No network connection",
                description: "Your draft is saved. We’ll reconnect when your network returns.",
            },
        );
    }
    if (session?.kind === "failed" || (session?.kind === "disconnected" && session.retry.kind === "exhausted")) {
        return present(
            { kind: "failed", label: "Connection unavailable" },
            {
                kind: "failed",
                title: session.kind === "failed" ? "Connection unavailable" : "Couldn’t reconnect",
                description:
                    session.kind === "failed" ? session.message : "Automatic retries stopped. Your draft is saved.",
            },
        );
    }
    if (computer.kind === "unpaired") {
        return present(
            { kind: "offline", label: "No computer connected" },
            {
                kind: "waiting",
                title: "Connect a computer",
                description: "Connect your local agent to start chatting.",
            },
        );
    }
    if ((session?.kind === "disconnected" || session?.kind === "reconnecting") && session.notice === "quiet") {
        return present({ kind: "recovering", label: "Reconnecting" }, { kind: "hidden" });
    }
    if (session?.kind === "disconnected") {
        return present(
            {
                kind: computer.kind === "disconnected" ? "offline" : "recovering",
                label: computer.kind === "disconnected" ? "Computer offline" : "Reconnecting",
            },
            {
                kind: "retrying",
                title: computer.kind === "disconnected" ? "Computer is offline" : "Reconnecting…",
                description:
                    computer.kind === "disconnected"
                        ? "Start Morty on this computer to reconnect. Your draft is saved."
                        : "Updates are paused. We’ll retry automatically. Your draft is saved.",
                remainingSeconds: session.retry.kind === "scheduled" ? session.retry.remainingSeconds : null,
            },
        );
    }
    if (computer.kind === "disconnected") {
        return present(
            { kind: "offline", label: "Computer offline" },
            {
                kind: "waiting",
                title: "Computer is offline",
                description: "Start Morty on this computer to reconnect. Your draft is saved.",
            },
        );
    }
    if (session?.kind === "reconnecting") {
        return present(
            { kind: "recovering", label: "Reconnecting" },
            {
                kind: "waiting",
                title: "Reconnecting…",
                description: "Updates are paused. Your draft is saved.",
            },
        );
    }
    if (computer.kind === "unavailable") {
        return present(
            { kind: "unknown", label: "Connection status unavailable" },
            {
                kind: "retrying",
                title: "Connection interrupted",
                description: "You can keep writing. Retry to check the connection.",
                remainingSeconds: null,
            },
        );
    }
    if (computer.kind === "connecting") {
        return present(
            { kind: "recovering", label: "Checking connection" },
            {
                kind: "waiting",
                title: "Checking connection…",
                description: "You can keep writing while we connect.",
            },
        );
    }
    if (
        session?.kind === "loading" ||
        session?.kind === "session-loading-after-create" ||
        (session === null && home.selection.kind === "loading")
    ) {
        return present(
            { kind: "recovering", label: "Connecting" },
            {
                kind: "waiting",
                title: "Connecting…",
                description: "You can keep writing while we connect.",
            },
        );
    }
    if (session === null && home.selection.kind === "failed") {
        return present({ kind: "failed", label: "Session unavailable" }, { kind: "hidden" });
    }
    return present({ kind: "ready", label: "Connection available" }, { kind: "hidden" });
}

function sessionLabel(session: SessionConnection | null, draft: boolean): ExecutionContext["connection"] {
    if (session === null) {
        return draft ? "Not started" : "Unavailable";
    }
    switch (session.kind) {
        case "loading":
        case "session-loading-after-create":
            return "Connecting";
        case "ready":
            return "Connected";
        case "disconnected":
            return session.retry.kind === "exhausted" ? "Unavailable" : "Reconnecting";
        case "reconnecting":
            return "Reconnecting";
        case "closed":
            return "Closed";
        case "failed":
            return "Unavailable";
    }
}
