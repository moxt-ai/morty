import type { SessionElicitationRequestedEvent, SessionPermissionRequestedEvent } from "@moxt-ai/mobius-sdk";
import type { ElicitationResponseRequest } from "@moxt-ai/mobius-sdk/channel";

export type PermissionInteraction = Pick<
    SessionPermissionRequestedEvent,
    "interactionId" | "options" | "sessionId" | "title" | "toolCallId" | "toolKind"
>;

export type ElicitationInteraction = Pick<
    SessionElicitationRequestedEvent,
    "accepted" | "fields" | "interactionId" | "message" | "mode" | "sessionId" | "url"
>;

export interface PermissionInteractionResponse {
    readonly interactionId: string;
    readonly optionId: string;
    readonly outcome: "cancelled" | "selected";
    readonly sessionId: string;
}

export interface ElicitationInteractionResponse {
    readonly action: ElicitationResponseRequest["action"];
    readonly content: string;
    readonly interactionId: string;
    readonly sessionId: string;
}
