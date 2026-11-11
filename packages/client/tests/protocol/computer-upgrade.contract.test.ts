import { describe, expect, it } from "vitest";
import { decodeDaemonToServiceMessage, decodeServiceToDaemonMessage } from "../../src/protocol/index.ts";

describe("Computer upgrade wire contract", () => {
    it("Given a server upgrade command, When decoded, Then remote upgrade triggering is rejected", () => {
        const request = { kind: "computer.upgrade.request", requestId: "upgrade_1", version: "0.0.228" };
        expect(() => decodeServiceToDaemonMessage(JSON.stringify(request))).toThrow();
    });
    it("Given a rolled back daemon, When it reports failure, Then the service receives a correlated error and cooldown", () => {
        const result = {
            kind: "computer.upgrade.result",
            requestId: "upgrade_1",
            version: "0.0.227",
            targetVersion: "0.0.228",
            outcome: {
                status: "failed",
                code: "worker_exited",
                message: "The new daemon exited before becoming ready",
                retryAfter: 3600000,
            },
        };
        expect(decodeDaemonToServiceMessage(JSON.stringify(result))).toEqual(result);
    });
});
