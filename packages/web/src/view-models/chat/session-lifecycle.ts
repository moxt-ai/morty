import type {
    MobiusClient,
    SessionElicitationRequestedEvent,
    SessionPermissionRequestedEvent,
} from "@morty-build/client";
import { promptCompletion, type SessionInteractionSnapshot, type SessionLiveEvent } from "@morty-build/client/protocol";
import type { SessionInteraction } from "./session-pane-types.ts";

// The Session pane reads Mobius lifecycle metadata only through this module, so
// a lifecycle protocol change is absorbed here instead of across pane workflows.

type LifecycleMetadata = Extract<SessionLiveEvent, { readonly type: "lifecycle-metadata" }>["payload"];
/** How far the native session's owner has taken a command the Runtime handed it: holding it, or running it. */
export type DelegationStage = Extract<LifecycleMetadata, { readonly kind: "prompt.delegated" }>["stage"];
type LifecycleEvent<Kind extends LifecycleMetadata["kind"]> = Extract<
    LifecycleMetadata,
    { readonly kind: Kind; readonly event: unknown }
>["event"];

/** What a lifecycle event means for the Session pane. */
export type SessionLifecycleFact =
    | { readonly kind: "interaction-requested"; readonly interaction: SessionInteraction }
    | {
          readonly kind: "permission-resolved";
          readonly interactionId: string;
          readonly optionId: string;
          readonly outcome: LifecycleEvent<"session.permission.resolved">["outcome"];
      }
    | {
          readonly kind: "elicitation-resolved";
          readonly interactionId: string;
          readonly action: LifecycleEvent<"session.elicitation.resolved">["action"];
      }
    | { readonly kind: "queue-changed" }
    | { readonly kind: "turn-started"; readonly commandId: string }
    /** The Runtime handed the command to the native session's owner, such as the Codex app, which runs it or not. */
    | { readonly kind: "turn-delegated"; readonly commandId: string; readonly stage: DelegationStage }
    | { readonly kind: "turn-completed"; readonly commandId: string; readonly steered: boolean }
    | { readonly kind: "turn-failed"; readonly commandId: string; readonly code: string; readonly message: string }
    /** The event changes nothing the pane tracks outside the message projection. */
    | { readonly kind: "none" };

export function sessionLifecycleFact(payload: LifecycleMetadata): SessionLifecycleFact {
    switch (payload.kind) {
        case "session.permission.requested":
        case "session.elicitation.requested":
            return { kind: "interaction-requested", interaction: requestedInteraction(payload.event) };
        case "session.permission.resolved":
            return {
                kind: "permission-resolved",
                interactionId: payload.event.interactionId,
                optionId: payload.event.optionId,
                outcome: payload.event.outcome,
            };
        case "session.elicitation.resolved":
            return {
                kind: "elicitation-resolved",
                interactionId: payload.event.interactionId,
                action: payload.event.action,
            };
        case "session.queue.changed":
            return { kind: "queue-changed" };
        case "prompt.requested":
            return { kind: "none" };
        case "prompt.started":
            return { kind: "turn-started", commandId: payload.commandId };
        case "prompt.delegated":
            return { kind: "turn-delegated", commandId: payload.commandId, stage: payload.stage };
        case "prompt.completed":
            return {
                kind: "turn-completed",
                commandId: payload.commandId,
                steered: promptCompletion(payload).kind === "steered",
            };
        case "prompt.failed":
        case "prompt.failed-before-start":
            return { kind: "turn-failed", commandId: payload.commandId, code: payload.code, message: payload.message };
        default:
            return payload satisfies never;
    }
}

/** The pending interaction a live request or an active-turn snapshot describes. */
export function requestedInteraction(
    event: SessionPermissionRequestedEvent | SessionElicitationRequestedEvent,
): SessionInteraction {
    switch (event.kind) {
        case "session.permission.requested":
            return { kind: "permission", permission: { ...event, state: { kind: "pending" } } };
        case "session.elicitation.requested": {
            const { accepted, ...elicitation } = event;
            return {
                kind: "elicitation",
                elicitation: {
                    ...elicitation,
                    state: accepted ? { action: "accept", content: "", kind: "submitted" } : { kind: "pending" },
                },
            };
        }
        default:
            return event satisfies never;
    }
}

export type SessionInteractionRecovery =
    | { readonly kind: "session"; readonly snapshot: SessionInteractionSnapshot }
    | { readonly kind: "legacy-turn"; readonly interactions: readonly SessionInteraction[] };

/** Older relays strip additive fields, so fallback belongs at the protocol adapter. */
export function sessionInteractionRecovery(
    execution: Awaited<ReturnType<MobiusClient["sessions"]["readSessionExecution"]>>,
): SessionInteractionRecovery {
    if (execution.interactionState !== undefined) {
        return { kind: "session", snapshot: execution.interactionState };
    }
    const interaction = execution.turn?.interaction;
    return { kind: "legacy-turn", interactions: interaction == null ? [] : [requestedInteraction(interaction)] };
}
