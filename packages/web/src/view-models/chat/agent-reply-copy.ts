import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import Anser from "anser";
import { isShellCommandToolCall, shellCommandOutput } from "../../lib/shell-command.ts";
import { type SessionExecutionState, type SessionMessage, sessionTextValue } from "./session-presentation.ts";

export interface AgentReplyMessageGroup {
    readonly id: string;
    readonly messages: readonly SessionMessage[];
}

/** Groups the session projection by the user message that started each Agent reply. */
export function agentReplyMessageGroups(messages: readonly SessionMessage[]): readonly AgentReplyMessageGroup[] {
    const groups: AgentReplyMessageGroup[] = [];
    let replyMessages: SessionMessage[] = [];
    const flush = (): void => {
        const first = replyMessages[0];
        if (first !== undefined) {
            groups.push({ id: first.firstEvent.eventId, messages: replyMessages });
        }
        replyMessages = [];
    };
    for (const message of messages) {
        if (message.role === "user") {
            flush();
        } else {
            replyMessages.push(message);
        }
    }
    flush();
    return groups;
}

function approvalCommand(message: SessionMessage, botId: string): string | null {
    if (message.role !== "assistant" || message.presentation.kind !== "failure") {
        return null;
    }
    return message.presentation.code === "binding_not_approved" && isIdentifier(botId)
        ? `mobius bot approve --bot ${botId}`
        : null;
}

/** Serializes every user-visible part of one settled Agent reply that could be copied from its controls. */
export function agentReplyCopyText(
    messages: readonly SessionMessage[],
    botId: string,
    execution: SessionExecutionState,
): string | null {
    if (execution.kind === "open") {
        return null;
    }
    const parts: string[] = [];
    for (const message of messages) {
        if (message.role !== "assistant") {
            continue;
        }
        const presentation = message.presentation;
        if (presentation.kind === "message" && presentation.content.type === "text") {
            const text = sessionTextValue(presentation.content.text);
            if (text.length > 0) {
                parts.push(text);
            }
        }
        if (presentation.kind === "tool") {
            const entry = presentation.entry;
            const output = isShellCommandToolCall(entry) ? shellCommandOutput(entry) : null;
            if (output !== null && output.length > 0) {
                parts.push(Anser.ansiToText(output));
            }
        }
        const command = approvalCommand(message, botId);
        if (command !== null) {
            parts.push(command);
        }
    }
    const text = parts.join("\n\n");
    return text.trim().length === 0 ? null : text;
}
