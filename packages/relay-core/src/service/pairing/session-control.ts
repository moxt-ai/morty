import { sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeNativeSessionRequest,
    decodeNativeSessionTarget,
    decodeSessionCancelBeforeStartCommand,
    decodeSessionCancelCommand,
    decodeSessionConfigReadCommand,
    decodeSessionConfigureCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionHistoryPageLoad,
    decodeSessionPermissionRespondCommand,
    decodeSessionPreviewHistoryPageLoad,
    decodeSessionPromptCommand,
    decodeSessionPromptDispositionCommand,
    decodeSessionQueryCommand,
    decodeSessionRenameCommand,
    type NativeSessionTarget,
    ProtocolMessageError,
    RUNTIME_WORKSPACE_BINDING_ID,
    type SessionPromptCommand,
} from "@morty-build/client/protocol";
import type { ProjectPermission } from "../../entity/authentication/project-authentication.ts";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import {
    nativeSessionRequestPermission,
    runtimeControlPermission,
    runtimeControlRegistry,
} from "./runtime-control-registry.ts";
import type { RuntimeControlCommand, RuntimeControlResult } from "./runtime-control-request.ts";

/**
 * Runs one command of a Session operation on a Runtime once the caller is authorized for `permission`, the operation's
 * own, and returns the Runtime's answer.
 */
export type RuntimeControl = (
    command: RuntimeControlCommand,
    permission: ProjectPermission,
) => Promise<RuntimeControlResult>;

/** The Agent and directories a Session runs in. */
export interface SessionExecutionIdentity {
    readonly agentId: string;
    readonly directoryId: string;
    readonly additionalDirectoryIds: readonly string[];
}

/**
 * A Session's binding as a caller states it for an operation on that existing Session. The Runtime owns the binding,
 * so each omitted field is the Session's own; each supplied field reaches the Runtime unchanged, which validates it.
 */
export interface SessionBindingRequest {
    readonly agentId?: string | undefined;
    readonly directoryId?: string | undefined;
    readonly additionalDirectoryIds?: readonly string[] | undefined;
}

export interface TurnSubmission extends SessionBindingRequest {
    readonly commandId: string;
    readonly content: string;
    readonly attachments: readonly unknown[];
    readonly disposition: string;
    readonly targetCommandId?: string | undefined;
    readonly sessionConfigurations: readonly unknown[];
}

/**
 * Where a submitted Turn's command stands when the Runtime answers its submission. `settled` answers a retried command
 * that had already ended: the Runtime states neither how nor when it ended, so the command's own lifecycle events
 * carry its outcome.
 */
export interface TurnAdmission {
    readonly commandId: string;
    readonly state: "queued" | "running" | "settled";
}

export type InteractionResponse =
    | { readonly kind: "permission"; readonly optionId: string; readonly outcome: "cancelled" | "selected" }
    | { readonly kind: "elicitation"; readonly action: "accept" | "cancel" | "decline"; readonly content: string };

export interface SessionConfiguration extends SessionBindingRequest {
    readonly configId: string;
    readonly expectedConfigurationRevision: string;
    readonly valueType: "select" | "boolean";
    readonly value: string;
    readonly booleanValue: boolean;
}

/**
 * The operations every Session API offers on one Session. Each builds the Runtime command, runs it through the
 * caller's authorized control and checks that the answer belongs to that command. An operation needs the permission of
 * the command it performs; a lookup it makes to build that command is part of it and needs nothing more. Routes
 * authenticate, decode their own request format and shape their own response; they do not repeat these rules.
 */
export class SessionControl {
    readonly #control: RuntimeControl;
    readonly #target: NativeSessionTarget;

    constructor(control: RuntimeControl, target: NativeSessionTarget) {
        this.#control = control;
        this.#target = decodeNativeSessionTarget(target);
    }

    readonly submitTurn = async (turn: TurnSubmission): Promise<TurnAdmission> => {
        const permission = runtimeControlRegistry["session.prompt"].permission;
        const binding = await this.#binding(turn, permission);
        let command: SessionPromptCommand;
        try {
            command = decodeSessionPromptCommand(
                JSON.stringify({
                    additionalDirectoryIds: binding.additionalDirectoryIds,
                    agentId: binding.agentId,
                    attachments: turn.attachments,
                    bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                    commandId: turn.commandId,
                    directoryId: binding.directoryId,
                    disposition: turn.disposition,
                    kind: "session.prompt",
                    prompt: turn.content,
                    sessionConfigurations: turn.sessionConfigurations,
                    target: this.#target,
                    targetCommandId: turn.targetCommandId,
                }),
            );
        } catch (error) {
            // The caller supplied this prompt, so protocol rejection is a client error, not a retryable outage.
            if (error instanceof ProtocolMessageError) {
                throw new PairingDirectoryError("invalid_request", "The Turn request is invalid", { cause: error });
            }
            throw error;
        }
        const result = await this.#control(command, permission);
        if (result.kind !== "session.prompt.accepted" || result.requestId !== command.commandId) {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid Turn");
        }
        return { commandId: result.requestId, state: result.state };
    };

    readonly cancelTurn = async (turnId: string): Promise<{ readonly stopReason: string }> => {
        const stopped = await this.#run(
            decodeSessionCancelCommand(
                JSON.stringify({
                    commandId: turnId,
                    kind: "session.cancel",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
        );
        if (stopped.kind !== "session.turn.stopped" || stopped.commandId !== turnId) {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid cancellation");
        }
        return { stopReason: stopped.stopReason };
    };

    /** Withdraws a Turn that has not started; one that already started cannot be withdrawn. */
    readonly withdrawTurn = async (turnId: string): Promise<void> => {
        const withdrawn = await this.#run(
            decodeSessionCancelBeforeStartCommand(
                JSON.stringify({
                    commandId: turnId,
                    kind: "session.cancel-before-start",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
        );
        if (withdrawn.kind !== "session.turn.withdrawn" || withdrawn.commandId !== turnId) {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid cancellation");
        }
    };

    readonly steerTurn = async (turnId: string): Promise<void> => {
        const steered = await this.#run(
            decodeSessionPromptDispositionCommand(
                JSON.stringify({
                    commandId: turnId,
                    disposition: "steer",
                    kind: "session.prompt.disposition",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
        );
        if (steered.kind !== "session.prompt.steered" || steered.commandId !== turnId) {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid steered Turn");
        }
    };

    readonly respond = async (interactionId: string, response: InteractionResponse): Promise<void> => {
        const requestId = crypto.randomUUID();
        const answered = await this.#run(
            response.kind === "permission"
                ? decodeSessionPermissionRespondCommand(
                      JSON.stringify({
                          interactionId,
                          kind: "session.permission.respond",
                          optionId: response.optionId,
                          outcome: response.outcome,
                          requestId,
                          target: this.#target,
                      }),
                  )
                : decodeSessionElicitationRespondCommand(
                      JSON.stringify({
                          action: response.action,
                          content: response.content,
                          interactionId,
                          kind: "session.elicitation.respond",
                          requestId,
                          target: this.#target,
                      }),
                  ),
        );
        if (answered.kind !== "session.interaction.answered" || answered.interactionId !== interactionId) {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid answer");
        }
    };

    readonly readConfiguration = async () => {
        const result = await this.#run(
            decodeSessionConfigReadCommand(
                JSON.stringify({
                    kind: "session.config.read",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
        );
        if (result.kind !== "session.config.read.result") {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned invalid Session settings");
        }
        return result;
    };

    readonly configure = async (configuration: SessionConfiguration) => {
        const permission = runtimeControlRegistry["session.configure"].permission;
        return await this.#control(
            decodeSessionConfigureCommand(
                JSON.stringify({
                    ...configuration,
                    ...(await this.#binding(configuration, permission)),
                    bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                    kind: "session.configure",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
            permission,
        );
    };

    readonly rename = async (title: string) =>
        await this.#run(
            decodeSessionRenameCommand(
                JSON.stringify({
                    kind: "session.rename",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                    title,
                }),
            ),
        );

    /** The Session's running Turn, and the delivery of `deliveryCommandId` when the caller names one. */
    readonly activeTurn = async (supplied: SessionBindingRequest, deliveryCommandId?: string) => {
        const permission = nativeSessionRequestPermission("active-turn");
        const identity = await this.#binding(supplied, permission);
        const result = await this.#control(
            decodeNativeSessionRequest(
                JSON.stringify({
                    action: "active-turn",
                    additionalDirectoryIds: identity.additionalDirectoryIds,
                    agentId: identity.agentId,
                    bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                    ...(deliveryCommandId === undefined ? {} : { deliveryCommandId }),
                    directoryId: identity.directoryId,
                    kind: "native.session.request",
                    requestId: crypto.randomUUID(),
                    discoveryId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
            permission,
        );
        if (result.kind !== "native.session.result" || result.action !== "active-turn") {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid active Turn");
        }
        return result;
    };

    /** A page of the Agent's native history for the Session, as Session events. */
    readonly previewEvents = async (
        supplied: SessionBindingRequest,
        page: { readonly cursor: string | null; readonly eventLimit: number },
    ) => {
        const permission = runtimeControlRegistry["session.preview-history.page.load"].permission;
        const identity = await this.#binding(supplied, permission);
        const result = await this.#control(
            decodeSessionPreviewHistoryPageLoad(
                JSON.stringify({
                    additionalDirectoryIds: identity.additionalDirectoryIds,
                    agentId: identity.agentId,
                    bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                    cursor: page.cursor,
                    directoryId: identity.directoryId,
                    eventLimit: page.eventLimit,
                    kind: "session.preview-history.page.load",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
            permission,
        );
        if (result.kind !== "session.preview-history.page.loaded") {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned invalid V2 Session events");
        }
        return result.events;
    };

    /** A page of the Session's live history. */
    readonly liveEvents = async (page: { readonly cursor: string | null; readonly eventLimit: number }) => {
        const result = await this.#run(
            decodeSessionHistoryPageLoad(
                JSON.stringify({
                    cursor: page.cursor,
                    eventLimit: page.eventLimit,
                    kind: "session.live-history.v2.page.load",
                    requestId: crypto.randomUUID(),
                    target: this.#target,
                }),
            ),
        );
        if (result.kind !== "session.live-history.v2.page.loaded") {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned invalid V2 Session events");
        }
        return result.events.events;
    };

    /** Runs an operation that is one command, under that command's own permission. */
    readonly #run = async (command: RuntimeControlCommand): Promise<RuntimeControlResult> =>
        await this.#control(command, runtimeControlPermission(command));

    /**
     * The binding an operation runs with: the caller's fields, and the Session's own from its Runtime for the rest.
     * Reading the Session's own binding is part of the operation, so it runs under the operation's `permission`.
     */
    readonly #binding = async (
        supplied: SessionBindingRequest,
        permission: ProjectPermission,
    ): Promise<SessionExecutionIdentity> => {
        const { additionalDirectoryIds, agentId, directoryId } = supplied;
        if (agentId !== undefined && agentId !== this.#target.harness) {
            throw new PairingDirectoryError("invalid_request", "The Session belongs to a different harness");
        }
        if (agentId !== undefined && directoryId !== undefined && additionalDirectoryIds !== undefined) {
            return { additionalDirectoryIds, agentId, directoryId };
        }
        const queried = await this.#control(
            decodeSessionQueryCommand(
                JSON.stringify({
                    kind: "session.query",
                    requestId: crypto.randomUUID(),
                    targets: [this.#target],
                }),
            ),
            permission,
        );
        if (queried.kind !== "session.queried") {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid Session query");
        }
        const session = queried.entries.find((entry) => sameNativeSession(entry.target, this.#target));
        if (session === undefined) {
            throw new PairingDirectoryError("session_not_found", "The selected Session is unavailable");
        }
        return {
            additionalDirectoryIds:
                additionalDirectoryIds ?? session.additionalDirectories.map((directory) => directory.directoryId),
            agentId: agentId ?? session.agentId,
            directoryId: directoryId ?? session.directoryId,
        };
    };
}
