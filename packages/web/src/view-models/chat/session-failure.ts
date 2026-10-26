import { MobiusError } from "@moxt-ai/mobius-sdk";
import { isChatBridgeError } from "../../services/api/websocket-api-transport.ts";
import { CloudApiError } from "../../services/management/management-api.ts";

export type SessionRecoveryAction =
    | { readonly kind: "retry"; readonly label: "Reconnect" | "Try again" }
    | { readonly kind: "new-session"; readonly label: "New Session" };

export interface SessionFailure {
    readonly title: string;
    readonly description: string;
    readonly action: SessionRecoveryAction;
    readonly diagnostic: {
        readonly code: string | null;
        readonly message: string;
    };
}

/** Recovery follows the typed failure; an Agent's diagnostic text never selects an action. */
export function sessionFailure(cause: unknown, context: "session" | "chat" = "session"): SessionFailure {
    const code = cause instanceof CloudApiError || cause instanceof MobiusError ? cause.code : null;
    const diagnostic = { code, message: cause instanceof Error ? cause.message : "No further details are available." };
    const present = (title: string, description: string, action: SessionRecoveryAction): SessionFailure => ({
        title,
        description,
        action,
        diagnostic,
    });
    if (isChatBridgeError(cause)) {
        return present("Connection interrupted", "Check your network connection, then reconnect.", {
            kind: "retry",
            label: "Reconnect",
        });
    }
    switch (code?.toLowerCase()) {
        case "runtime_offline":
        case "connection_closed":
            return present(
                "Computer is offline",
                "Keep the original computer awake and online, and start Morty there. Then reconnect.",
                { kind: "retry", label: "Reconnect" },
            );
        case "not_found":
        case "session_not_found":
        case "native_session_not_found":
            return present("Session unavailable", "Open another session or start a new one.", {
                kind: "new-session",
                label: "New Session",
            });
        case "authentication_required":
            return present(
                "Your agent needs authentication",
                "Sign in to the agent on the original computer or check its API key, then try again.",
                { kind: "retry", label: "Try again" },
            );
        case "agent_required":
        case "agent_not_found":
        case "harness_unavailable":
            return present(
                "Agent unavailable",
                "Open the required agent on the original computer and connect it to Morty, then try again.",
                { kind: "retry", label: "Try again" },
            );
        case "local_authorization_failed":
            return present(
                "Local access unavailable",
                "Check the requested directory and access permissions on the original computer, then try again.",
                { kind: "retry", label: "Try again" },
            );
        case "platform_timeout":
        case "operation_timeout":
            return present("Opening the session timed out", "The request took too long. Try opening it again.", {
                kind: "retry",
                label: "Try again",
            });
        case "platform_unavailable":
        case "service_unavailable":
            return present("Connection temporarily unavailable", "Morty could not reach your session. Try again.", {
                kind: "retry",
                label: "Try again",
            });
        default:
            return context === "chat"
                ? present("Morty could not be opened", "Check your connection, then try again.", {
                      kind: "retry",
                      label: "Try again",
                  })
                : present(
                      "This session could not be opened",
                      "Check this session in the agent on the original computer, or start a new one here.",
                      { kind: "new-session", label: "New Session" },
                  );
    }
}
