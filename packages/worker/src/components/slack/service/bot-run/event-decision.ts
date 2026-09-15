type MentionType = "MENTION_THIS_APP" | "MENTION_OTHER_APP" | "NO_MENTION";

type EventLocation = "DM_TOP" | "DM_THREAD" | "CHANNEL_TOP" | "CHANNEL_THREAD";

type SessionState = "NO_SESSION" | "HAS_SESSION";

import type { BotSender, ContextLoadType, Sender, UserSender } from "../../entity/conversation";

export type { ContextLoadType, Sender } from "../../entity/conversation";

export interface DecisionInput {
    readonly botInitiatedThread:
        | { readonly kind: "not-checked" }
        | { readonly initiatedByTarget: boolean; readonly kind: "checked" };
    readonly command: "NEW_SESSION" | null;
    readonly location: EventLocation;
    readonly mentionType: MentionType;
    readonly sender: Sender;
    readonly sessionState: SessionState;
}

export type Decision =
    | {
          readonly action: "CREATE_SESSION";
          readonly contextLoadType: ContextLoadType;
          readonly sender: UserSender;
      }
    | {
          readonly action: "CREATE_SESSION_BY_BOT";
          readonly contextLoadType: ContextLoadType;
          readonly sender: BotSender;
      }
    | {
          readonly action: "REUSE_SESSION";
          readonly contextLoadType: ContextLoadType;
          readonly sender: Sender;
      }
    | {
          readonly action: "SKIP";
          readonly reason: SkipReason;
          readonly sender: Sender;
      };

type SkipReason = "BOT_NOT_AUTHORIZED" | "CHANNEL_TOP_REQUIRES_MENTION" | "THREAD_REQUIRES_MENTION_OR_SESSION";

function contextForNewSession(location: EventLocation): ContextLoadType {
    switch (location) {
        case "DM_TOP":
        case "CHANNEL_TOP":
            return "CHANNEL_FULL";
        case "DM_THREAD":
        case "CHANNEL_THREAD":
            return "THREAD_FULL_WITH_CHANNEL";
    }
}

function createSession(sender: Sender, contextLoadType: ContextLoadType): Decision {
    switch (sender.kind) {
        case "bot":
            return {
                action: "CREATE_SESSION_BY_BOT",
                contextLoadType,
                sender,
            };
        case "user":
            return { action: "CREATE_SESSION", contextLoadType, sender };
    }
}

export function decideSlackEvent(input: DecisionInput): Decision {
    const { command, location, mentionType, sender, sessionState } = input;

    if (sender.kind === "bot" && targetBotCannotBeUsed(input)) {
        return { action: "SKIP", reason: "BOT_NOT_AUTHORIZED", sender };
    }

    const isDirectMessage = location === "DM_TOP" || location === "DM_THREAD";
    const commandCanApply = isDirectMessage || mentionType === "MENTION_THIS_APP";
    if (command === "NEW_SESSION" && commandCanApply) {
        return createSession(sender, contextForNewSession(location));
    }

    switch (location) {
        case "DM_TOP":
            return sessionState === "HAS_SESSION"
                ? {
                      action: "REUSE_SESSION",
                      contextLoadType: "CHANNEL_INCREMENTAL",
                      sender,
                  }
                : createSession(sender, "CHANNEL_FULL");
        case "DM_THREAD":
            return sessionState === "HAS_SESSION"
                ? {
                      action: "REUSE_SESSION",
                      contextLoadType: "THREAD_INCREMENTAL",
                      sender,
                  }
                : createSession(sender, "THREAD_FULL_WITH_CHANNEL");
        case "CHANNEL_TOP":
            return mentionType === "MENTION_THIS_APP"
                ? createSession(sender, "CHANNEL_FULL")
                : {
                      action: "SKIP",
                      reason: "CHANNEL_TOP_REQUIRES_MENTION",
                      sender,
                  };
        case "CHANNEL_THREAD":
            if (sessionState === "HAS_SESSION") {
                return {
                    action: "REUSE_SESSION",
                    contextLoadType: "THREAD_INCREMENTAL",
                    sender,
                };
            }
            if (
                mentionType === "MENTION_THIS_APP" ||
                (input.botInitiatedThread.kind === "checked" && input.botInitiatedThread.initiatedByTarget)
            ) {
                return createSession(sender, "THREAD_FULL_WITH_CHANNEL");
            }
            return {
                action: "SKIP",
                reason: "THREAD_REQUIRES_MENTION_OR_SESSION",
                sender,
            };
    }
}

function targetBotCannotBeUsed(input: DecisionInput): boolean {
    return input.sender.kind === "bot" && input.sender.targetAccess === "denied";
}
