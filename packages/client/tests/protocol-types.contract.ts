// @ts-expect-error Validation schemas are private implementation details.
import type { ContentBlock, contentBlockSchema, PromptMetadata, PromptUsage } from "@morty-build/client/protocol";

import { SESSION_COMMANDS_UPDATED_KIND, type SessionCommandsUpdatedEvent } from "@morty-build/client/protocol";

declare const hiddenSchema: contentBlockSchema;

const content: ContentBlock = { text: "hello", type: "text" };
const usage: PromptUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const metadata: PromptMetadata = { messageId: "message-1" };

void content;
void hiddenSchema;
void metadata;
void usage;

// Existing external imports and the command event shape survive internal observer cleanup.
const commandsKind: "session.commands.updated" = SESSION_COMMANDS_UPDATED_KIND;
const commandsUpdated: SessionCommandsUpdatedEvent = {
    commands: [{ description: "Review the workspace", inputHint: "optional focus", name: "review" }],
    kind: "session.commands.updated",
    target: { harness: "codex", sessionId: "session-1" },
};

void commandsKind;
void commandsUpdated;
