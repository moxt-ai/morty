import {
    encodeSessionPromptCommand,
    SESSION_PROMPT_KIND,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { executePrompt } from "../../../session/prompt/execute-prompt.ts";
import type { RuntimeCommand } from "../definition.ts";
import { send } from "../transport.ts";
import { reply, replySettledFailure, settledCommand } from "../turn-replies.ts";

export const sessionPromptCommand: RuntimeCommand = {
    kind: SESSION_PROMPT_KIND,
    handle: (context, message): void => {
        if (message.kind !== SESSION_PROMPT_KIND) {
            throw new Error("Command kind mismatch");
        }
        if (!context.sessionTurns.acceptsPrompts()) {
            send(context.socket, {
                code: "runtime_upgrading",
                requestId: message.commandId,
                kind: "session.operation.failed",
                message: "The Runtime is upgrading. Retry after it reconnects.",
                target: message.target,
            });
            return;
        }
        // A prompt names only its Session; it runs with the Agent and directory of the Session this Runtime holds.
        const session = context.sessions.findSessions([message.target])[0];
        if (session === undefined) {
            send(context.socket, {
                code: "session_not_found",
                requestId: message.commandId,
                kind: "session.operation.failed",
                message: "The Session was not found",
                target: message.target,
            });
            return;
        }
        // A steer joins a running turn, so the Session admits it only while the Agent runs the turn it names. An
        // appended prompt is always admitted: the Session runs or queues it.
        const receipt = context.operations.claimExecution(
            message.commandId,
            message.target,
            encodeSessionPromptCommand(message),
            () =>
                message.disposition === SessionPromptDisposition.Append ||
                context.sessions.acceptsSteering(message.target, message.targetCommandId),
        );
        if (receipt.kind === "refused") {
            send(context.socket, {
                code: "steering_target_unavailable",
                requestId: message.commandId,
                kind: "session.operation.failed",
                message: "The turn to steer is not running.",
                target: message.target,
            });
            return;
        }
        if (receipt.kind === "conflict") {
            send(context.socket, {
                code: "command_identity_conflict",
                requestId: message.commandId,
                kind: "session.operation.failed",
                message: "This command identifier was already used for a different request.",
                target: message.target,
            });
            return;
        }
        if (receipt.kind === "duplicate") {
            // A retry is answered with where the original command stands, as its receipt records it. A settled outcome
            // is also restated for clients that missed it.
            reply(context.socket, {
                kind: "session.prompt.accepted",
                requestId: message.commandId,
                target: message.target,
                state:
                    receipt.state === "settled"
                        ? "settled"
                        : context.sessionTurns.get(message.commandId, message.target)?.isQueued() === true
                          ? "queued"
                          : "running",
            });
            const outcome =
                receipt.state === "settled" ? context.operations.restatedOutcome(message.commandId) : undefined;
            if (outcome !== undefined) {
                context.eventProjection.restateOutcome(message.target, outcome);
            }
            return;
        }
        if (receipt.kind === "expired") {
            send(context.socket, {
                code: "command_result_expired",
                requestId: message.commandId,
                kind: "session.operation.failed",
                message:
                    "This command already started. Its execution result is no longer available; it will not run again.",
                target: message.target,
            });
            return;
        }
        context.eventProjection.requested(message, { harness: session.harness, directory: session.cwd });
        const { commandId, target } = message;
        // A prompt is answered once, at the first of: it entered the queue, it started, or it ended without starting.
        let answered = false;
        const accepted = (state: "queued" | "running" | "settled"): void => {
            if (!answered) {
                answered = true;
                reply(context.socket, { kind: "session.prompt.accepted", requestId: commandId, target, state });
            }
        };
        const queueChanged = (): void => {
            void context.eventProjection.queueChanged(target, commandId).catch((error: unknown) => {
                console.error("Could not record queue change", error);
            });
        };
        // A prompt behind a running turn enters the queue as it arrives, so the queue follows arrival order.
        const turn = context.sessionTurns.start(message, receipt.attemptId, () => {
            queueChanged();
            accepted("queued");
        });
        const ended = (): void => {
            if (answered) {
                return;
            }
            const settled = settledCommand(context.operations, commandId);
            if (settled.kind === "completed") {
                accepted("settled");
                return;
            }
            answered = true;
            replySettledFailure(context.socket, commandId, target, settled);
        };
        const waiting = new AbortController();
        context.operations
            .progress(commandId, target, AbortSignal.any([waiting.signal, context.signal]))
            .then((progress) => {
                if (progress === "started") {
                    accepted("running");
                }
            })
            .catch(() => undefined);
        void executePrompt({
            eventProjection: context.eventProjection,
            command: message,
            session,
            resolveAgent: context.resolveAgent,
            readArtifact: async (attachment, signal) => {
                const artifact = await context.externalContent.read(
                    message.target,
                    `morty-content:${attachment.kind}:${attachment.contentKey}`,
                    signal,
                );
                if (artifact === null) {
                    throw new Error("The prompt attachment is unavailable");
                }
                return { bytes: artifact.bytes, path: artifact.path };
            },
            reportFailure: context.diagnostics.daemonDiagnostic,
            directories: context.directories,
            sessions: context.sessions,
            attemptId: receipt.attemptId,
            epoch: turn.epoch,
            waitForSessionAdmission: (signal) => context.sessionTurns.admitAndWait(turn, signal),
            signal: turn.signal,
        })
            .catch((error: unknown) => {
                console.error("Morty daemon turn failed", error);
            })
            .finally(() => {
                waiting.abort();
                ended();
                context.sessionTurns.finish(turn);
                context.eventProjection.publishTerminal(message.target, message.commandId);
                // Only a prompt that entered the queue changes it by leaving.
                if (turn.enteredQueue()) {
                    queueChanged();
                }
            });
    },
};
