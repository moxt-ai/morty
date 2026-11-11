import { describe, expect, it } from "vitest";
import { decodeTurn } from "../../src/protocol/index.ts";

describe("Morty resource contract", () => {
    it("Given a persisted Turn page, When a caller decodes it, Then every terminal state round-trips", () => {
        const turn = {
            acceptedAt: "2026-09-07T00:00:01.000Z",
            idempotencyKey: "submit-a",
            request: { kind: "not_retained" },
            target: { harness: "claude", sessionId: "session-a" },
            turnId: "turn-a",
        };
        const terminalStates = [
            {
                completedAt: "2026-09-07T00:00:03.000Z",
                kind: "succeeded",
                result: { kind: "agent_result", stopReason: "end_turn" },
            },
            {
                error: { code: "agent_failed", message: "The Agent failed", retryable: false },
                failedAt: "2026-09-07T00:00:03.000Z",
                kind: "failed",
            },
            { cancelledAt: "2026-09-07T00:00:03.000Z", kind: "cancelled" },
        ];
        for (const state of terminalStates) {
            const decoded = decodeTurn({ ...turn, state });
            expect(decoded).not.toBeNull();
            if (decoded === null) {
                throw new Error("expected a known Turn");
            }
            expect(decoded.state.kind).toBe(state.kind);
        }
        const queued = decodeTurn({
            ...turn,
            request: { content: "hello", kind: "prompt", sessionConfigurations: [] },
            state: { kind: "queued" },
        });
        expect(queued).not.toBeNull();
        if (queued === null) {
            throw new Error("expected a known Turn");
        }
        expect(queued.request.kind).toBe("prompt");
    });
});
