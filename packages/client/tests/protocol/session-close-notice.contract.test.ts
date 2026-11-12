import {
    decodeDaemonToServiceMessage,
    decodeSessionCloseNoticeEvent,
    encodeDaemonToServiceMessage,
    SESSION_CLOSE_NOTICE_KIND,
} from "@morty-build/client/protocol";
import { describe, expect, it } from "vitest";

describe("Session close notice contracts", () => {
    it("Given a Computer reports that it is archiving a Session, When the notice crosses the daemon-to-service boundary, Then receivers decode the same notice with its reason", () => {
        const notice = {
            kind: SESSION_CLOSE_NOTICE_KIND,
            reason: "This Session was closed on request.",
            target: { harness: "claude", sessionId: "session-1" },
        } as const;

        expect(decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(notice))).toEqual(notice);
    });

    it("Given a reason worded by a newer Computer, When a receiver decodes the notice, Then any reason of up to 500 characters arrives as sent", () => {
        for (const reason of ["This Session was closed after 24 hours without activity.", "r".repeat(500)]) {
            const encoded = JSON.stringify({
                kind: SESSION_CLOSE_NOTICE_KIND,
                reason,
                target: { harness: "claude", sessionId: "session-1" },
            });

            expect(decodeSessionCloseNoticeEvent(encoded)).toEqual({
                kind: SESSION_CLOSE_NOTICE_KIND,
                reason,
                target: { harness: "claude", sessionId: "session-1" },
            });
        }
    });

    it("Given a notice from a newer Computer with an extra field, When a receiver decodes it, Then the unrecognized field is ignored", () => {
        const encoded = JSON.stringify({
            closedAt: "2026-10-22T00:00:00.000Z",
            kind: SESSION_CLOSE_NOTICE_KIND,
            reason: "This Session was closed on request.",
            target: { harness: "claude", sessionId: "session-1" },
        });

        expect(decodeSessionCloseNoticeEvent(encoded)).toEqual({
            kind: SESSION_CLOSE_NOTICE_KIND,
            reason: "This Session was closed on request.",
            target: { harness: "claude", sessionId: "session-1" },
        });
    });

    it("Given a notice without a valid Session identifier or reason, When it crosses the boundary, Then it is rejected", () => {
        const reason = "This Session was closed on request.";
        const invalid = [
            { kind: SESSION_CLOSE_NOTICE_KIND, reason },
            { kind: SESSION_CLOSE_NOTICE_KIND, reason, sessionId: "" },
            { kind: SESSION_CLOSE_NOTICE_KIND, sessionId: "session-1" },
            { kind: SESSION_CLOSE_NOTICE_KIND, reason: "", sessionId: "session-1" },
            { kind: SESSION_CLOSE_NOTICE_KIND, reason: "r".repeat(501), sessionId: "session-1" },
        ];

        for (const notice of invalid) {
            expect(() => decodeSessionCloseNoticeEvent(JSON.stringify(notice))).toThrow();
        }
    });
});
