import { createHash, randomUUID } from "node:crypto";
import {
    type CommandDelivery,
    decodeKnownSessionEventPayload,
    encodeSessionCancelBeforeStartCommand,
    isPromptTerminal,
    type LastTurnOutcome,
    type PromptMessageOutcome,
    promptCompletion,
    type SessionEventPayload,
    type SessionLiveEvent,
} from "@morty-build/client/protocol";
import { z } from "zod";
import type { CommandFate, CommandLedgerTable, LedgerCommand } from "../../storage/session/command-ledger-table.ts";

export type RuntimeExecutionReceipt =
    | Readonly<{
          attemptId: string;
          commandId: string;
          kind: "accepted";
      }>
    | Readonly<{
          attemptId: string;
          commandId: string;
          kind: "duplicate";
          // Whether the original command has ended, as its receipt records it.
          state: "settled" | "unsettled";
      }>
    | { readonly kind: "conflict" }
    | { readonly kind: "expired" };

/**
 * An outcome a restart publishes: one the restart itself settles (a command it interrupted), or one the previous
 * process had already recorded, which is published again for clients that missed it.
 */
export type RecoveredOutcome =
    | {
          readonly kind: "recorded";
          readonly sessionId: string;
          readonly event: SessionEventPayload;
          readonly recordedAt: string;
      }
    | { readonly kind: "restated"; readonly sessionId: string; readonly outcome: RestatedOutcome };

/**
 * An outcome the ledger already holds, restated for clients that missed it. It keeps the time it was recorded, which
 * identifies when the command ended; undefined when the ledger no longer keeps it.
 */
export interface RestatedOutcome {
    readonly event: SessionEventPayload;
    readonly recordedAt: string | undefined;
}

/** What a cancellation before admission found: a cancellation it recorded, or an outcome recorded earlier. */
export type CancellationBeforeAdmission =
    | { readonly kind: "recorded"; readonly outcome: SessionEventPayload }
    | { readonly kind: "restated"; readonly outcome: RestatedOutcome }
    | { readonly kind: "unavailable" }
    | { readonly kind: "expired" };

const isStarted = (fate: CommandFate): boolean => fate.kind === "started" || fate.kind === "settled-after-start";

const isUnsettled = (fate: CommandFate): fate is UnsettledFate => fate.kind === "pending" || fate.kind === "started";

const lifecyclePayload = (outcome: string) => {
    const event = decodeKnownSessionEventPayload(JSON.parse(outcome));
    return event?.type === "lifecycle-metadata" ? event.payload : undefined;
};

/** A restart failed the command before it started, so its identifier may run again. */
function restartedBeforeStart(outcome: string): boolean {
    const payload = lifecyclePayload(outcome);
    return payload?.kind === "prompt.failed-before-start" && payload.code === "runtime_restarted";
}

type UnsettledFate = Extract<CommandFate, { readonly kind: "pending" | "started" }>;
type SettledCommandFate = Exclude<CommandFate, UnsettledFate>;

/** How an unsettled command settles with `outcome`: a completion as cancelled before it started is a cancellation. */
function settledFate(fate: UnsettledFate, outcome: string): SettledCommandFate {
    if (fate.kind === "started") {
        return { kind: "settled-after-start", startedAt: fate.startedAt, outcome };
    }
    const payload = lifecyclePayload(outcome);
    return payload?.kind === "prompt.completed" && promptCompletion(payload).kind === "cancelled"
        ? { kind: "cancelled", outcome }
        : { kind: "settled-before-start", outcome };
}

/** What a command identifier means to one Session: whether it may run, and what happened to it. */
type CommandStanding =
    // Nothing is recorded: the command may run.
    | { readonly kind: "unseen" }
    // Another Session owns the identifier.
    | { readonly kind: "foreign" }
    // A restart failed the command before it started: it may run again.
    | { readonly kind: "retryable" }
    // The ledger answers for the command, unsettled or with its outcome, and it does not run again.
    | { readonly kind: "retained"; readonly command: LedgerCommand }
    // The command started, and its outcome is no longer kept.
    | { readonly kind: "expired"; readonly commandHash: string }
    // The command was cancelled before it started, and its outcome is no longer kept.
    | { readonly kind: "cancelled" };

function commandStanding(command: LedgerCommand | undefined, sessionId: string): CommandStanding {
    if (command === undefined) {
        return { kind: "unseen" };
    }
    if (command.sessionId !== sessionId) {
        return { kind: "foreign" };
    }
    const fate = command.fate;
    switch (fate.kind) {
        case "pending":
        case "started":
            return { kind: "retained", command };
        case "cancelled":
            return fate.outcome === null ? { kind: "cancelled" } : { kind: "retained", command };
        case "settled-before-start":
            return restartedBeforeStart(fate.outcome) ? { kind: "retryable" } : { kind: "retained", command };
        case "settled-after-start":
            return fate.outcome === null
                ? { kind: "expired", commandHash: command.commandHash }
                : { kind: "retained", command };
        default:
            return fate satisfies never;
    }
}

const cancelledBeforeStartOutcome = (commandId: string): SessionEventPayload => ({
    type: "lifecycle-metadata",
    payload: { kind: "prompt.completed", commandId, stopReason: "cancelled", execution: "not-started" },
});

/** A stored outcome: the event as recorded, with its recording time. */
const storedOutcome = (stored: string): RestatedOutcome | undefined => {
    const parsed: unknown = JSON.parse(stored);
    const event = decodeKnownSessionEventPayload(parsed);
    return event === null
        ? undefined
        : { event, recordedAt: z.object({ recordedAt: z.string() }).parse(parsed).recordedAt };
};

/**
 * The Runtime's answers about the commands it admitted, read from the command ledger, which alone records what
 * became of each command.
 */
export class ExecutionReceipts {
    readonly #ledger: CommandLedgerTable;
    readonly #onCount: (count: number) => void;
    /**
     * The terminal events this process recorded with the Agent's own failure text. That text can quote user input, so
     * it never enters the ledger, which keeps the content-free form; clients of this process still read the original.
     */
    readonly #agentOutcomes = new Map<string, string>();
    /**
     * Settlements reached while this process shuts down. They are artifacts of stopping, not of the commands, so the
     * ledger keeps the commands unsettled and the next process reports that the restart interrupted them.
     */
    readonly #shutdownSettlements = new Map<string, CommandFate>();
    #closing = false;

    constructor(ledger: CommandLedgerTable, onCount: (count: number) => void = () => undefined) {
        this.#ledger = ledger;
        this.#onCount = onCount;
    }

    readonly #withShutdownSettlement = (command: LedgerCommand): LedgerCommand => {
        const fate = this.#shutdownSettlements.get(command.commandId);
        return fate === undefined ? command : { ...command, fate };
    };
    readonly #read = (commandId: string): LedgerCommand | undefined => {
        const command = this.#ledger.read(commandId);
        return command === undefined ? undefined : this.#withShutdownSettlement(command);
    };
    readonly #standing = (commandId: string, sessionId: string): CommandStanding =>
        commandStanding(this.#read(commandId), sessionId);
    /** The outcome clients read for a settled command: what this process recorded, else the ledger's form. */
    readonly #outcome = ({ commandId, fate }: LedgerCommand): string | undefined => {
        if (isUnsettled(fate) || fate.outcome === null) {
            return undefined;
        }
        return this.#agentOutcomes.get(commandId) ?? fate.outcome;
    };
    readonly #publishCount = (): void => {
        this.#onCount(this.#ledger.unsettled().filter((commandId) => !this.#shutdownSettlements.has(commandId)).length);
    };
    /** Settles an unsettled command. `agentOutcome` is the outcome with the Agent's text, when it differs. */
    readonly #settle = (commandId: string, fate: UnsettledFate, outcome: string, agentOutcome?: string): void => {
        const settled = settledFate(fate, outcome);
        if (agentOutcome !== undefined) {
            this.#agentOutcomes.set(commandId, agentOutcome);
        }
        if (this.#closing) {
            this.#shutdownSettlements.set(commandId, settled);
        } else {
            for (const dropped of this.#ledger.settle(commandId, settled.kind, outcome)) {
                this.#agentOutcomes.delete(dropped);
            }
        }
        this.#publishCount();
    };

    readonly beginShutdown = (): void => {
        this.#closing = true;
    };
    readonly outcome = (commandId: string): SessionEventPayload | undefined => this.restatedOutcome(commandId)?.event;
    /** The outcome the ledger keeps for the command, with the time it was recorded. */
    readonly restatedOutcome = (commandId: string): RestatedOutcome | undefined => {
        const command = this.#read(commandId);
        const outcome = command === undefined ? undefined : this.#outcome(command);
        return outcome === undefined ? undefined : storedOutcome(outcome);
    };
    /** The command's delivery as the ledger knows it; another Session's command reads as unknown. */
    readonly delivery = (commandId: string, sessionId: string): CommandDelivery => {
        const standing = this.#standing(commandId, sessionId);
        switch (standing.kind) {
            case "unseen":
            case "foreign":
                return { state: "unknown" };
            case "expired":
                return { state: "expired" };
            case "cancelled":
                // A command that never started has no result to lose: it stays cancelled.
                return { state: "completed", stopReason: "cancelled" };
            case "retryable":
            case "retained":
                break;
            default:
                return standing satisfies never;
        }
        const command = this.#read(commandId);
        if (command === undefined || isUnsettled(command.fate)) {
            return { state: "accepted" };
        }
        const outcome = this.outcome(commandId);
        if (outcome?.type !== "lifecycle-metadata" || !isPromptTerminal(outcome.payload)) {
            return { state: "expired" };
        }
        switch (outcome.payload.kind) {
            case "prompt.completed":
                return { state: "completed", stopReason: outcome.payload.stopReason };
            case "prompt.failed":
            case "prompt.failed-before-start":
                return { code: outcome.payload.code, state: "failed" };
        }
    };
    /**
     * How the Session's most recently admitted turn ended. Commands that never started (queued, or reserved for
     * cancellation) are not turns, unless they failed before starting. A steering command that completed as `steered`
     * joined the turn it steered, which reports for both; a steer not known to have joined (it failed, or a restart
     * interrupted it) keeps its own outcome. Undefined while the latest turn runs or its outcome is no longer kept.
     */
    readonly lastTurn = (sessionId: string): LastTurnOutcome | undefined => {
        let last: { readonly commandId: string; readonly outcome: SessionEventPayload | undefined } | undefined;
        for (const stored of this.#ledger.session(sessionId)) {
            const command = this.#withShutdownSettlement(stored);
            const outcome = this.outcome(command.commandId);
            const payload = outcome?.type === "lifecycle-metadata" ? outcome.payload : undefined;
            const failedBeforeStart = payload?.kind === "prompt.failed-before-start";
            const steered = payload?.kind === "prompt.completed" && promptCompletion(payload).kind === "steered";
            const kept = command.fate.kind === "started" || outcome !== undefined;
            if (kept && (isStarted(command.fate) || failedBeforeStart) && !steered) {
                last = { commandId: command.commandId, outcome };
            }
        }
        const outcome = last?.outcome;
        if (last === undefined || outcome?.type !== "lifecycle-metadata" || !isPromptTerminal(outcome.payload)) {
            return undefined;
        }
        switch (outcome.payload.kind) {
            case "prompt.completed":
                return { commandId: last.commandId, state: "completed", stopReason: outcome.payload.stopReason };
            case "prompt.failed":
            case "prompt.failed-before-start":
                return {
                    code: outcome.payload.code,
                    commandId: last.commandId,
                    message: outcome.payload.message,
                    state: "failed",
                };
        }
    };
    /** When the Session's running command started. */
    readonly startedAt = (commandId: string, sessionId: string): string | undefined => {
        const command = this.#read(commandId);
        return command?.sessionId === sessionId && command.fate.kind === "started" ? command.fate.startedAt : undefined;
    };
    /**
     * The recorded terminal events of the Session's settled prompts whose Agent reported the user message they
     * recorded, while the ledger keeps their outcomes.
     */
    readonly promptOutcomes = (sessionId: string): readonly PromptMessageOutcome[] => {
        const outcomes: PromptMessageOutcome[] = [];
        for (const command of this.#ledger.session(sessionId)) {
            const outcome = this.restatedOutcome(command.commandId);
            const event = outcome?.event;
            if (
                outcome?.recordedAt !== undefined &&
                event?.type === "lifecycle-metadata" &&
                (event.payload.kind === "prompt.completed" || event.payload.kind === "prompt.failed") &&
                event.payload.messageId !== undefined
            ) {
                outcomes.push({ payload: event.payload, recordedAt: outcome.recordedAt });
            }
        }
        return outcomes;
    };
    /** A command that started stays started after its outcome is no longer kept. */
    readonly hasStarted = (commandId: string, sessionId: string): boolean => {
        const standing = this.#standing(commandId, sessionId);
        switch (standing.kind) {
            case "unseen":
            case "foreign":
            case "cancelled":
            case "retryable":
                return false;
            case "expired":
                return true;
            case "retained":
                return isStarted(standing.command.fate);
            default:
                return standing satisfies never;
        }
    };

    /**
     * Reserves an unseen command for cancellation before a delayed prompt can claim its identity. A command that
     * already has an outcome keeps it, and the outcome is restated rather than recorded again.
     */
    readonly recordCancellationBeforeAdmission = (
        commandId: string,
        sessionId: string,
    ): CancellationBeforeAdmission => {
        const standing = this.#standing(commandId, sessionId);
        switch (standing.kind) {
            case "foreign":
                return { kind: "unavailable" };
            case "retryable":
            case "retained": {
                const outcome = this.restatedOutcome(commandId);
                return outcome === undefined ? { kind: "unavailable" } : { kind: "restated", outcome };
            }
            case "expired":
                // Execution is known, but its outcome is unavailable; never invent a cancellation result.
                return { kind: "expired" };
            case "cancelled":
                return {
                    kind: "restated",
                    outcome: { event: cancelledBeforeStartOutcome(commandId), recordedAt: undefined },
                };
            case "unseen":
                break;
            default:
                return standing satisfies never;
        }
        const outcome = cancelledBeforeStartOutcome(commandId);
        // The identifier belongs to the cancellation, so a later prompt conflicts rather than executing.
        const commandHash = createHash("sha256")
            .update(
                encodeSessionCancelBeforeStartCommand({
                    commandId,
                    kind: "session.cancel-before-start",
                    sessionId,
                }),
            )
            .digest("hex");
        for (const dropped of this.#ledger.admitCancelled(
            { attemptId: randomUUID(), commandHash, commandId, sessionId },
            JSON.stringify({ ...outcome, recordedAt: new Date().toISOString() }),
        )) {
            this.#agentOutcomes.delete(dropped);
        }
        return { kind: "recorded", outcome };
    };
    /**
     * The ledger follows each command's recorded lifecycle. `prompt.started` is recorded where the command is handed
     * to the Agent, so the started mark and the event clients see are one transition; a terminal event settles the
     * command. Nothing else marks a command started.
     */
    readonly record = (event: SessionLiveEvent): void => {
        if (event.type !== "lifecycle-metadata") {
            return;
        }
        const payload = event.payload;
        if (payload.kind === "prompt.started") {
            // A start reported after settlement does not reopen the execution.
            this.#ledger.start(payload.commandId, event.recordedAt);
            return;
        }
        if (!isPromptTerminal(payload)) {
            return;
        }
        const fate = this.#read(payload.commandId)?.fate;
        if (fate === undefined || !isUnsettled(fate)) {
            return;
        }
        const outcome = { type: "lifecycle-metadata", payload, recordedAt: event.recordedAt };
        if (payload.kind === "prompt.completed") {
            this.#settle(payload.commandId, fate, JSON.stringify(outcome));
            return;
        }
        const contentFree = { ...payload, message: "The local Agent could not complete the request" };
        this.#settle(
            payload.commandId,
            fate,
            JSON.stringify({ ...outcome, payload: contentFree }),
            JSON.stringify(outcome),
        );
    };
    readonly recover = (): readonly RecoveredOutcome[] => {
        const recovered: RecoveredOutcome[] = [];
        for (const command of this.#ledger.all()) {
            const fate = command.fate;
            if (!isUnsettled(fate)) {
                // The previous process recorded this outcome; publishing it again restates that fact.
                const restated = fate.outcome === null ? undefined : storedOutcome(fate.outcome);
                if (restated !== undefined) {
                    recovered.push({ kind: "restated", sessionId: command.sessionId, outcome: restated });
                }
                continue;
            }
            const event: SessionEventPayload = {
                type: "lifecycle-metadata",
                payload:
                    fate.kind === "started"
                        ? {
                              kind: "prompt.failed",
                              commandId: command.commandId,
                              attemptId: command.attemptId,
                              code: "runtime_restarted",
                              message: "The local runtime restarted while this request was running",
                          }
                        : {
                              kind: "prompt.failed-before-start",
                              commandId: command.commandId,
                              code: "runtime_restarted",
                              message: "The local runtime restarted before this request started",
                          },
            };
            const recordedAt = new Date().toISOString();
            recovered.push({ kind: "recorded", sessionId: command.sessionId, event, recordedAt });
            this.#settle(command.commandId, fate, JSON.stringify({ ...event, recordedAt }));
        }
        return recovered;
    };

    readonly claimExecution = (commandId: string, sessionId: string, commandJson: string): RuntimeExecutionReceipt => {
        const commandHash = createHash("sha256").update(commandJson).digest("hex");
        const standing = this.#standing(commandId, sessionId);
        switch (standing.kind) {
            case "foreign":
            case "cancelled":
                return { kind: "conflict" };
            case "retained":
                if (standing.command.commandHash !== commandHash) {
                    return { kind: "conflict" };
                }
                return {
                    attemptId: standing.command.attemptId,
                    commandId,
                    kind: "duplicate",
                    state: isUnsettled(standing.command.fate) ? "unsettled" : "settled",
                };
            case "expired":
                return standing.commandHash === commandHash ? { kind: "expired" } : { kind: "conflict" };
            case "retryable":
            // A restart failed it before it started: the admission replaces that failure.
            case "unseen":
                break;
            default:
                return standing satisfies never;
        }
        const attemptId = randomUUID();
        this.#ledger.admit({ attemptId, commandHash, commandId, sessionId });
        this.#publishCount();
        return { attemptId, commandId, kind: "accepted" };
    };

    /** Only commands without a terminal result can still be cancelled. */
    readonly findUnsettledAttemptId = (commandId: string, sessionId: string): string | null => {
        const command = this.#read(commandId);
        return command?.sessionId === sessionId && isUnsettled(command.fate) ? command.attemptId : null;
    };

    readonly isTerminalExecution = (commandId: string, sessionId: string): boolean => {
        const command = this.#read(commandId);
        return command?.sessionId === sessionId && !isUnsettled(command.fate);
    };

    readonly close = (): void => {
        this.#agentOutcomes.clear();
        this.#shutdownSettlements.clear();
    };
}
