import { randomUUID } from "node:crypto";
import { sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeIdentifier,
    type NativeSessionResult,
    type NativeSessionTarget,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    type SessionElicitationRequestedEvent,
    type SessionElicitationResolvedEvent,
    type SessionPermissionRequestedEvent,
    type SessionPermissionResolvedEvent,
    type SessionPromptCommand,
    SessionPromptDisposition,
    type SessionPromptDispositionCommand,
} from "@morty-build/client/protocol";

type ActiveTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"];

/** Interaction events the daemon folds into an in-flight prompt Turn. */
export type RecordedSessionEvent =
    | SessionElicitationRequestedEvent
    | SessionElicitationResolvedEvent
    | SessionPermissionRequestedEvent
    | SessionPermissionResolvedEvent;

/**
 * How an admitted prompt executes: as its own turn, or by steering the running turn of `targetCommandId`. An appended
 * prompt promoted out of the queue steers the turn it waited behind, which admission names when it admits it.
 */
export type PromptDispatch = { readonly kind: "own" } | { readonly kind: "steer"; readonly targetCommandId: string };

/**
 * Where a prompt stands in its Session's admission. Whether it started belongs to its execution receipt: the turn
 * reads that fact instead of keeping a copy of it.
 */
type TurnAdmission =
    | { readonly kind: "waiting" }
    | { readonly kind: "queued"; readonly promotion: PromiseWithResolvers<void> }
    | { readonly kind: "promoted" }
    | { readonly kind: "admitted"; readonly dispatch: PromptDispatch; readonly fromQueue: boolean };

export type TurnCancellation =
    | { readonly kind: "already-requested" }
    | { readonly kind: "pending" }
    | { readonly kind: "running"; readonly execution: string };

export class ActiveRuntimeTurn {
    readonly attemptId: string;
    readonly command: SessionPromptCommand;
    readonly epoch = decodeIdentifier(randomUUID());
    readonly #controller: AbortController;
    readonly #finished = Promise.withResolvers<void>();
    readonly #started: () => boolean;
    readonly #startedAt: () => string | undefined;
    #cancellationRequested = false;
    #admission: TurnAdmission = { kind: "waiting" };
    #sequence = 0;
    #interaction: Extract<
        RecordedSessionEvent,
        { readonly kind: typeof SESSION_PERMISSION_REQUESTED_KIND | typeof SESSION_ELICITATION_REQUESTED_KIND }
    > | null = null;

    /**
     * `started` and `startedAt` read the command's execution receipt, the single owner of whether and when the command
     * started.
     */
    constructor(
        command: SessionPromptCommand,
        attemptId: string,
        started: () => boolean,
        startedAt: () => string | undefined,
    ) {
        this.attemptId = attemptId;
        this.command = command;
        this.#controller = new AbortController();
        this.#started = started;
        this.#startedAt = startedAt;
    }

    readonly enqueue = (): void => {
        if (this.#admission.kind !== "waiting") {
            throw new Error("Only a waiting prompt can enter the queue");
        }
        this.#admission = { kind: "queued", promotion: Promise.withResolvers<void>() };
    };

    /** Whether the prompt was admitted to its Session's queue, whatever happened to it afterwards. */
    readonly enteredQueue = (): boolean =>
        this.#admission.kind === "queued" ||
        this.#admission.kind === "promoted" ||
        (this.#admission.kind === "admitted" && this.#admission.fromQueue);

    readonly isQueued = (): boolean =>
        (this.#admission.kind === "queued" ||
            (this.#admission.kind === "admitted" &&
                this.#admission.fromQueue &&
                this.#admission.dispatch.kind === "own")) &&
        !this.#started() &&
        !this.#controller.signal.aborted;

    readonly abortRuntime = (): void => {
        this.#controller.abort();
    };

    readonly finish = (): void => {
        this.#finished.resolve();
    };

    readonly promoteQueuedPrompt = (
        command: SessionPromptDispositionCommand,
    ): "accepted" | "already-started" | "unavailable" => {
        if (
            command.commandId !== this.command.commandId ||
            !sameNativeSession(command.target, this.command.target) ||
            this.#controller.signal.aborted
        ) {
            return "unavailable";
        }
        switch (this.#admission.kind) {
            case "queued": {
                const promotion = this.#admission.promotion;
                this.#admission = { kind: "promoted" };
                promotion.resolve();
                return "accepted";
            }
            case "promoted":
                return "accepted";
            case "admitted":
                return this.#admission.dispatch.kind === "steer" ? "accepted" : "already-started";
            case "waiting":
                return "unavailable";
        }
    };

    /**
     * Fixes how the prompt executes before asynchronous Agent preparation, so a late promotion cannot change a dispatch
     * that execution has already selected.
     */
    readonly admit = (dispatch: PromptDispatch): PromptDispatch => {
        const fromQueue = this.enteredQueue();
        this.#admission = { kind: "admitted", dispatch, fromQueue };
        return dispatch;
    };

    readonly queuePromotion = (): Promise<void> | null => {
        if (this.#admission.kind === "queued") {
            return this.#admission.promotion.promise;
        }
        return this.#admission.kind === "promoted" ? Promise.resolve() : null;
    };

    /** Whether the prompt joins another turn's execution instead of owning one, so it holds no place in the queue. */
    readonly isSteering = (): boolean => {
        switch (this.#admission.kind) {
            case "waiting":
                return this.command.disposition === SessionPromptDisposition.Steer;
            case "queued":
                return false;
            case "promoted":
                return true;
            case "admitted":
                return this.#admission.dispatch.kind === "steer";
        }
    };

    /** A steering prompt joins the execution of the turn it steers; every other prompt owns its execution. */
    readonly execution = (): string =>
        this.#admission.kind === "admitted" && this.#admission.dispatch.kind === "steer"
            ? this.#admission.dispatch.targetCommandId
            : this.command.commandId;

    readonly recordEvent = (event: RecordedSessionEvent): RecordedSessionEvent => {
        if (
            !sameNativeSession(event.target, this.command.target) ||
            ("commandId" in event && event.commandId !== this.command.commandId)
        ) {
            return event;
        }
        if (event.kind === SESSION_PERMISSION_REQUESTED_KIND || event.kind === SESSION_ELICITATION_REQUESTED_KIND) {
            this.#interaction = event;
        } else if (
            (event.kind === SESSION_PERMISSION_RESOLVED_KIND || event.kind === SESSION_ELICITATION_RESOLVED_KIND) &&
            this.#interaction?.interactionId === event.interactionId
        ) {
            this.#interaction = null;
        }
        return event;
    };

    readonly snapshot = (): ActiveTurnSnapshot => {
        const startedAt = this.#startedAt();
        if (startedAt === undefined) {
            // Admission may not have started, or settlement may precede removal from the active index.
            return null;
        }
        return {
            commandId: decodeIdentifier(this.command.commandId),
            epoch: this.epoch,
            interaction: this.#interaction,
            sequence: this.#sequence,
            startedAt,
            state: "running",
        };
    };

    readonly matchesInteraction = (interactionId: string, sessionTarget: NativeSessionTarget): boolean =>
        sameNativeSession(this.command.target, sessionTarget) && this.#interaction?.interactionId === interactionId;

    /**
     * Before the command starts, cancellation withdraws it by aborting its own admission and preparation. Once it
     * started, the Agent execution it belongs to must be asked to stop.
     */
    readonly requestCancellation = (): TurnCancellation => {
        if (this.#cancellationRequested) {
            return { kind: "already-requested" };
        }
        this.#cancellationRequested = true;
        if (!this.#started()) {
            this.#controller.abort(new Error("The Agent turn was cancelled before it started"));
            return { kind: "pending" };
        }
        return { kind: "running", execution: this.execution() };
    };

    readonly cancellationRequested = (): boolean => this.#cancellationRequested;

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    get completion(): Promise<void> {
        return this.#finished.promise;
    }
}
