import {
    promptCompletion,
    SESSION_CANCEL_BEFORE_START_KIND,
    SESSION_CANCEL_KIND,
    SESSION_CLOSE_KIND,
    SESSION_CLOSED_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_INTERACTION_ANSWERED_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_STEERED_KIND,
    SESSION_TURN_STOPPED_KIND,
    SESSION_TURN_WITHDRAWN_KIND,
} from "@morty-build/client/protocol";
import { SessionError } from "../../../session/api/session-error.ts";
import { settleAbandonedTurn } from "../../../session/prompt/prompt-lifecycle.ts";
import type { CommandContext } from "../context.ts";
import type { RuntimeCommand } from "../definition.ts";
import { reportOperationFailure, send } from "../transport.ts";
import { reply, replyFailure, replySettledFailure, settledCommand } from "../turn-replies.ts";

/** Answers a request that waited for its Turn to end with how the Turn ended. */
function replyStopped(
    { operations, socket }: CommandContext,
    {
        commandId,
        requestId,
        sessionId,
    }: { readonly commandId: string; readonly requestId: string; readonly sessionId: string },
): void {
    const settled = settledCommand(operations, commandId);
    if (settled.kind === "completed") {
        reply(socket, {
            commandId,
            kind: SESSION_TURN_STOPPED_KIND,
            requestId,
            sessionId,
            stopReason: settled.stopReason,
        });
        return;
    }
    replySettledFailure(socket, requestId, sessionId, settled);
}

export const sessionCancelCommand: RuntimeCommand = {
    kind: SESSION_CANCEL_KIND,
    handle: (context, message): void => {
        if (message.kind !== SESSION_CANCEL_KIND) {
            throw new Error("Command kind mismatch");
        }
        const { eventProjection, operations, sessions, sessionTurns, signal, socket } = context;
        const { commandId, requestId, sessionId } = message;
        const turn = sessionTurns.get(commandId, sessionId);
        const stop = async (): Promise<void> => {
            if (turn === undefined) {
                await settleAbandonedTurn(eventProjection, operations, message);
                if (!operations.isTerminalExecution(commandId, sessionId)) {
                    replyFailure(socket, requestId, sessionId, "turn_not_active", "The turn is not running.");
                    return;
                }
            } else {
                const cancellation = turn.requestCancellation();
                if (cancellation.kind === "running") {
                    await sessions.cancelPrompt(sessionId, cancellation.execution, signal);
                }
                await operations.settlement(commandId, sessionId, signal);
            }
            replyStopped(context, message);
        };
        void stop().catch((error: unknown) => {
            if (!signal.aborted) {
                reportOperationFailure(socket, requestId, sessionId, error);
            }
        });
    },
};

export const sessionCancelBeforeStartCommand: RuntimeCommand = {
    kind: SESSION_CANCEL_BEFORE_START_KIND,
    handle: ({ eventProjection, operations, sessionTurns, signal, socket }, message): void => {
        if (message.kind !== SESSION_CANCEL_BEFORE_START_KIND) {
            throw new Error("Command kind mismatch");
        }
        const { commandId, requestId, sessionId } = message;
        const withdrawn = (): void =>
            reply(socket, { commandId, kind: SESSION_TURN_WITHDRAWN_KIND, requestId, sessionId });
        const alreadyStarted = (): void =>
            reportOperationFailure(
                socket,
                requestId,
                sessionId,
                new SessionError("turn_already_started", "The message already started and could not be withdrawn"),
            );
        if (operations.hasStarted(commandId, sessionId)) {
            alreadyStarted();
            return;
        }
        const turn = sessionTurns.get(commandId, sessionId);
        if (turn === undefined) {
            const cancelled = operations.recordCancellationBeforeAdmission(commandId, sessionId);
            const outcome =
                cancelled.kind === "unavailable" || cancelled.kind === "expired"
                    ? undefined
                    : cancelled.kind === "restated"
                      ? cancelled.outcome.event
                      : cancelled.outcome;
            if (
                outcome?.type === "lifecycle-metadata" &&
                outcome.payload.kind === "prompt.completed" &&
                promptCompletion(outcome.payload).kind === "cancelled"
            ) {
                if (cancelled.kind === "restated") {
                    eventProjection.restateOutcome(sessionId, cancelled.outcome);
                    withdrawn();
                    return;
                }
                void eventProjection
                    .recordOutcome(sessionId, outcome)
                    .then(withdrawn)
                    .catch((error: unknown) => {
                        reportOperationFailure(socket, requestId, sessionId, error);
                    });
                return;
            }
            reportOperationFailure(
                socket,
                requestId,
                sessionId,
                new SessionError("turn_not_active", "The command is not waiting to start"),
            );
            return;
        }
        // No await separates checking admission from requesting cancellation.
        turn.requestCancellation();
        void operations
            .progress(commandId, sessionId, signal)
            .then((progress) => {
                if (progress === "started") {
                    alreadyStarted();
                    return;
                }
                const settled = settledCommand(operations, commandId);
                if (settled.kind !== "completed") {
                    replySettledFailure(socket, requestId, sessionId, settled);
                } else if (settled.cancelledBeforeStart) {
                    withdrawn();
                } else {
                    alreadyStarted();
                }
            })
            .catch(() => undefined);
    },
};

export const sessionCloseCommand: RuntimeCommand = {
    kind: SESSION_CLOSE_KIND,
    handle: ({ sessions, signal, socket }, message): void => {
        if (message.kind !== SESSION_CLOSE_KIND) {
            throw new Error("Command kind mismatch");
        }
        void sessions
            .closeSession(message.sessionId, signal)
            .then(() => {
                send(socket, { kind: SESSION_CLOSED_KIND, requestId: message.requestId, sessionId: message.sessionId });
            })
            .catch((error: unknown) => {
                reportOperationFailure(socket, message.requestId, message.sessionId, error);
            });
    },
};

export const promptDispositionCommand: RuntimeCommand = {
    kind: SESSION_PROMPT_DISPOSITION_KIND,
    handle: ({ diagnostics, operations, sessionTurns, signal, socket }, message): void => {
        if (message.kind !== SESSION_PROMPT_DISPOSITION_KIND) {
            throw new Error("Command kind mismatch");
        }
        const { commandId, requestId, sessionId } = message;
        const turn = sessionTurns.get(commandId, sessionId);
        const result = turn?.promoteQueuedPrompt(message) ?? "unavailable";
        if (result === "accepted") {
            // The steered prompt is answered once it starts inside the running Turn.
            void operations
                .progress(commandId, sessionId, signal)
                .then((progress) => {
                    if (progress === "started") {
                        reply(socket, { commandId, kind: SESSION_PROMPT_STEERED_KIND, requestId, sessionId });
                        return;
                    }
                    const settled = settledCommand(operations, commandId);
                    if (settled.kind !== "completed") {
                        replySettledFailure(socket, requestId, sessionId, settled);
                        return;
                    }
                    replyFailure(
                        socket,
                        requestId,
                        sessionId,
                        "turn_not_active",
                        "The message ended before it was steered.",
                    );
                })
                .catch(() => undefined);
            return;
        }
        const started = result === "already-started" || operations.hasStarted(commandId, sessionId);
        const error = started
            ? new SessionError("turn_already_started", "The message already left the queue and could not be steered")
            : new SessionError("turn_not_active", "The message is no longer waiting to be steered");
        diagnostics.daemonDiagnostic("session_prompt_disposition_failed", commandId, {
            code: error.code,
            commandId,
            sessionId,
        });
        reportOperationFailure(socket, requestId, sessionId, error);
    },
};

export const permissionRespondCommand: RuntimeCommand = {
    kind: SESSION_PERMISSION_RESPOND_KIND,
    handle: ({ sessions, socket }, message): void => {
        if (message.kind !== SESSION_PERMISSION_RESPOND_KIND) {
            throw new Error("Command kind mismatch");
        }
        const { interactionId, requestId, sessionId } = message;
        void sessions
            .respondPermission(message)
            .then(() => reply(socket, { interactionId, kind: SESSION_INTERACTION_ANSWERED_KIND, requestId, sessionId }))
            .catch((error: unknown) => {
                reportOperationFailure(socket, requestId, sessionId, error);
            });
    },
};

export const elicitationRespondCommand: RuntimeCommand = {
    kind: SESSION_ELICITATION_RESPOND_KIND,
    handle: ({ sessions, socket }, message): void => {
        if (message.kind !== SESSION_ELICITATION_RESPOND_KIND) {
            throw new Error("Command kind mismatch");
        }
        const { interactionId, requestId, sessionId } = message;
        void sessions
            .respondElicitation(message)
            .then(() => reply(socket, { interactionId, kind: SESSION_INTERACTION_ANSWERED_KIND, requestId, sessionId }))
            .catch((error: unknown) => {
                reportOperationFailure(socket, requestId, sessionId, error);
            });
    },
};
