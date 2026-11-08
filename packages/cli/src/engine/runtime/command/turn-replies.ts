import { type DaemonToServiceMessage, promptCompletion } from "@morty-build/client/protocol";
import { WebSocket } from "undici";
import type { ExecutionReceipts } from "../../session/turn/execution-receipts.ts";
import { send } from "./transport.ts";

/** How a settled command ended, as the ledger's outcome records it. */
export type SettledCommand =
    | { readonly kind: "completed"; readonly stopReason: string; readonly cancelledBeforeStart: boolean }
    | { readonly kind: "failed"; readonly code: string; readonly message: string }
    | { readonly kind: "unavailable" };

export function settledCommand(operations: ExecutionReceipts, commandId: string): SettledCommand {
    const outcome = operations.outcome(commandId);
    if (outcome?.type !== "lifecycle-metadata") {
        return { kind: "unavailable" };
    }
    const payload = outcome.payload;
    switch (payload.kind) {
        case "prompt.completed":
            return {
                kind: "completed",
                stopReason: payload.stopReason,
                cancelledBeforeStart: promptCompletion(payload).kind === "cancelled",
            };
        case "prompt.failed":
        case "prompt.failed-before-start":
            return { kind: "failed", code: payload.code, message: payload.message };
        default:
            return { kind: "unavailable" };
    }
}

/**
 * Answers a request on the connection that carried it. A reply that outlives its connection has no reader: the Relay
 * failed the request when that connection closed.
 */
export function reply(socket: WebSocket, message: DaemonToServiceMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
        send(socket, message);
    }
}

export function replyFailure(
    socket: WebSocket,
    requestId: string,
    sessionId: string,
    code: string,
    message: string,
): void {
    reply(socket, { code, kind: "session.operation.failed", message, requestId, sessionId });
}

/** Answers a request with a settled command's failure, or with the loss of its outcome. */
export function replySettledFailure(
    socket: WebSocket,
    requestId: string,
    sessionId: string,
    settled: Exclude<SettledCommand, { readonly kind: "completed" }>,
): void {
    if (settled.kind === "failed") {
        replyFailure(socket, requestId, sessionId, settled.code, settled.message);
        return;
    }
    replyFailure(
        socket,
        requestId,
        sessionId,
        "command_result_expired",
        "The command ended, but its result is no longer available.",
    );
}
