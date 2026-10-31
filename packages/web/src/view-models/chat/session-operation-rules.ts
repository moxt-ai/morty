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
 * Whether the Session takes a message for `target` now: it is connected and its settings are not changing. A new turn
 * needs none current; a queued message needs the turn it waits behind running and not being stopped.
 */
function sessionAccepts(
    target: DeliveryTarget,
    facts: Pick<SessionOperationFacts, "connection" | "configuring" | "turn" | "stopping">,
): boolean {
    return (
        facts.connection === "ready" &&
        !facts.configuring &&
        (target.disposition === "queue"
            ? acceptedTurn(facts.turn)?.commandId === target.targetCommandId && !facts.stopping
            : facts.turn.kind !== "current")
    );
}

/**
 * Whether delivery can take a message for `target` now: the Session accepts it, with no earlier submission being
 * prepared, submitted or unresolved.
 */
export function canSubmit(
    target: DeliveryTarget,
    facts: Pick<SessionOperationFacts, "connection" | "configuring" | "delivery" | "turn" | "stopping">,
): boolean {
    return (
        facts.delivery !== "preparing" &&
        facts.delivery !== "submitting" &&
        facts.delivery !== "delivery-unknown" &&
        sessionAccepts(target, facts)
    );
}

/** What the user's submissions also need: a reachable Machine and no question awaiting the user's answer. */
function userCanReachSession(facts: SessionOperationFacts): boolean {
    return facts.connectionAvailable && !facts.waitingForInput;
}

/** A submission the user makes, which delivery takes as a new submission. */
function userCanSubmit(target: DeliveryTarget, facts: SessionOperationFacts): boolean {
    return userCanReachSession(facts) && canSubmit(target, facts);
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
 * Retrying a message whose delivery is unknown sends its request again under the same identity and target, so the
 * Runtime runs it at most once. That unresolved delivery is the one this retry settles; otherwise the retry needs what
 * submitting the message for that target needs, so a Runtime that would refuse it does not spend its identity.
 */
export function canRetryUnknownDelivery(target: DeliveryTarget, facts: SessionOperationFacts): boolean {
    return facts.delivery === "delivery-unknown" && userCanReachSession(facts) && sessionAccepts(target, facts);
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
