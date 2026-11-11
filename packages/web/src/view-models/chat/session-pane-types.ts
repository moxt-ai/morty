import type { SessionElicitationRequestedEvent, SessionPermissionRequestedEvent } from "@morty-build/client";

import type { NativeSessionTarget } from "@morty-build/client/protocol";

type PermissionInteractionDetails = Pick<
    SessionPermissionRequestedEvent,
    "details" | "interactionId" | "options" | "target" | "title" | "toolCallId" | "toolKind"
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
    "fields" | "interactionId" | "message" | "mode" | "target" | "url"
>;

type ElicitationInteractionState =
    | { readonly kind: "pending" }
    | {
          readonly action: ElicitationInteractionResponse["action"];
          readonly content: string;
          readonly kind: "submitted";
      }
    | {
          readonly action: ElicitationInteractionResponse["action"] | "complete";
          readonly content: string;
          readonly kind: "resolved";
      };

export type ElicitationInteraction = ElicitationInteractionDetails & {
    readonly state: ElicitationInteractionState;
};

/** An Agent request the user answers in the Session pane. */
export type SessionInteraction =
    | { readonly kind: "permission"; readonly permission: PermissionInteraction }
    | { readonly kind: "elicitation"; readonly elicitation: ElicitationInteraction };

export interface PermissionInteractionResponse {
    readonly interactionId: string;
    readonly optionId: string;
    readonly outcome: "cancelled" | "selected";
    readonly target: NativeSessionTarget;
}

export interface ElicitationInteractionResponse {
    readonly action: "accept" | "decline" | "cancel";
    readonly content: string;
    readonly interactionId: string;
    readonly target: NativeSessionTarget;
}
