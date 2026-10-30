import type { SessionConnection } from "./session-connection.ts";
import { acceptedTurn, type CurrentTurn } from "./session-current-turn.ts";
import type { DeliveryTarget, SessionDeliveryStore } from "./session-delivery-store.ts";

/**
 * The facts that decide which of the user's operations the Session pane accepts now. The presentation disables a
 * control and the action refuses through the same rule over the same facts, so the two cannot disagree.
 */
export interface SessionOperationFacts {
    /** The network, the Machine and this Session's stream are all available, as the connection header reports. */
    readonly connectionAvailable: boolean;
    readonly connection: SessionConnection["kind"];
    readonly turn: CurrentTurn;
    /** The user asked to stop the running turn. */
    readonly stopping: boolean;
    /** A change to the Session's settings is in flight. */
    readonly configuring: boolean;
    readonly delivery: SessionDeliveryStore["state"]["kind"];
    /** The Agent waits for the user's answer to a permission request or question. */
    readonly waitingForInput: boolean;
}

const NEW_TURN: DeliveryTarget = { disposition: "reject", targetCommandId: "" };

/**
 * Whether delivery can take a message for `target` now: on a connected Session whose settings are not changing, with
 * no earlier submission being prepared, submitted or unresolved. A new turn needs none current; a queued message needs
 * the turn it waits behind running and not being stopped.
 */
export function canSubmit(
    target: DeliveryTarget,
    facts: Pick<SessionOperationFacts, "connection" | "configuring" | "delivery" | "turn" | "stopping">,
): boolean {
    return (
        facts.connection === "ready" &&
        !facts.configuring &&
        facts.delivery !== "preparing" &&
        facts.delivery !== "submitting" &&
        facts.delivery !== "delivery-unknown" &&
        (target.disposition === "queue"
            ? acceptedTurn(facts.turn)?.commandId === target.targetCommandId && !facts.stopping
            : facts.turn.kind !== "current")
    );
}

/** A submission the user makes also needs a reachable Machine and no question awaiting the user's answer. */
function userCanSubmit(target: DeliveryTarget, facts: SessionOperationFacts): boolean {
    return facts.connectionAvailable && !facts.waitingForInput && canSubmit(target, facts);
}

/** Sending the composer's message as a new turn. One message is in delivery at a time. */
export function canSendNow(facts: SessionOperationFacts): boolean {
    return facts.delivery === "idle" && userCanSubmit(NEW_TURN, facts);
}

/** Queueing the composer's message behind the running turn, which is what the composer does while a turn runs. */
export function canQueue(facts: SessionOperationFacts): boolean {
    const running = acceptedTurn(facts.turn);
    return (
        running !== null &&
        facts.delivery === "idle" &&
        userCanSubmit({ disposition: "queue", targetCommandId: running.commandId }, facts)
    );
}

/** Retrying a failed message submits it again exactly as it was meant: as a new turn or behind its target turn. */
export function canRetryFailedMessage(target: DeliveryTarget, facts: SessionOperationFacts): boolean {
    return userCanSubmit(target, facts);
}

/**
 * Changing the Session's settings. Settings have their own acknowledged operation, independent of prompt output and
 * permission requests: keep submission and stop boundaries stable and serialize edits.
 */
export function canChangeSettings(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection" | "configuring" | "delivery" | "stopping">,
): boolean {
    return (
        facts.connectionAvailable &&
        facts.connection === "ready" &&
        !facts.configuring &&
        facts.delivery === "idle" &&
        !facts.stopping
    );
}

/** The composer holds a message to send or queue: text or files, with no file still being read. */
export function composerHasMessage(draft: string, attachmentCount: number, readingAttachments: boolean): boolean {
    return !readingAttachments && (draft.trim() !== "" || attachmentCount > 0);
}
