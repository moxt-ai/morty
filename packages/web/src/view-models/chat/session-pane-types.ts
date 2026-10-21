import type { SessionElicitationRequestedEvent, SessionPermissionRequestedEvent } from "@moxt-ai/mobius-sdk";
import type { ElicitationResponseRequest } from "@moxt-ai/mobius-sdk/channel";

type PermissionInteractionDetails = Pick<
    SessionPermissionRequestedEvent,
    "details" | "interactionId" | "options" | "sessionId" | "title" | "toolCallId" | "toolKind"
>;

type PermissionInteractionState =
    | { readonly kind: "pending" }
    | {
          readonly kind: "submitted";
          readonly optionId: string;
          readonly outcome: PermissionInteractionResponse["outcome"];
      }
    | {
          readonly kind: "resolved";
          readonly optionId: string;
          readonly outcome: PermissionInteractionResponse["outcome"];
      };

export type PermissionInteraction = PermissionInteractionDetails & {
    readonly state: PermissionInteractionState;
};

type ElicitationInteractionDetails = Pick<
    SessionElicitationRequestedEvent,
    "fields" | "interactionId" | "message" | "mode" | "sessionId" | "url"
>;

type ElicitationInteractionState =
    | { readonly kind: "pending" }
    | {
          readonly action: ElicitationResponseRequest["action"];
          readonly content: string;
          readonly kind: "submitted";
      }
    | {
          readonly action: ElicitationResponseRequest["action"] | "complete";
          readonly content: string;
          readonly kind: "resolved";
      };

export type ElicitationInteraction = ElicitationInteractionDetails & {
    readonly state: ElicitationInteractionState;
};

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
