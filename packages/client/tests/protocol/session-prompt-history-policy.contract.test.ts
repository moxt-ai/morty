import {
    decodeSessionPromptCommand,
    encodeSessionPromptCommand,
    SessionHistoryPolicy,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { describe, expect, it } from "vitest";

const prompt = {
    additionalDirectoryIds: [],
    agentId: "agent-1",
    bindingId: "binding-1",
    commandId: "command-1",
    directoryId: "directory-1",
    disposition: SessionPromptDisposition.Append,
    attachments: [],
    kind: "session.prompt" as const,
    prompt: "continue",
    sessionId: "session-1",
};

describe("Session prompt history policy", () => {
    it("preserves execution-only prompts across the Runtime command boundary", () => {
        const encoded = encodeSessionPromptCommand({
            ...prompt,
            historyPolicy: SessionHistoryPolicy.ExecutionOnly,
        });

        expect(decodeSessionPromptCommand(encoded)).toMatchObject({
            historyPolicy: SessionHistoryPolicy.ExecutionOnly,
        });
    });

    it.each(["historyPolicy", "disposition"])(
        "Given a prompt missing %s, When it crosses the command boundary, Then the retired format is rejected",
        (field) => {
            const wire: Record<string, unknown> = { ...prompt, historyPolicy: SessionHistoryPolicy.Eager };
            delete wire[field];
            expect(() => decodeSessionPromptCommand(JSON.stringify(wire))).toThrow();
        },
    );

    it("rejects unknown history policies instead of silently replaying history", () => {
        expect(() => decodeSessionPromptCommand(JSON.stringify({ ...prompt, historyPolicy: "best-effort" }))).toThrow(
            "historyPolicy",
        );
    });
});
