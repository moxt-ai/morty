import { COMPUTER_PING_KIND, COMPUTER_PONG_KIND } from "@morty-build/client/protocol";
import packageMetadata from "../../../../../package.json" with { type: "json" };
import { computerEnvironmentDiagnostics } from "../../observability/environment-diagnostics.ts";
import type { ComputerCommand } from "../definition.ts";
import { send } from "../transport.ts";

export const computerDiagnosticsCommand: ComputerCommand = {
    kind: "computer.diagnostics.read",
    handle: ({ config, diagnostics, socket }, message): void => {
        if (message.kind !== "computer.diagnostics.read") {
            throw new Error("Command kind mismatch");
        }
        try {
            send(socket, {
                kind: "computer.diagnostics.result",
                requestId: message.requestId,
                version: packageMetadata.version,
                ...diagnostics.snapshot(computerEnvironmentDiagnostics(config)),
            });
        } catch {
            send(socket, {
                kind: "session.operation.failed",
                requestId: message.requestId,
                code: "diagnostics_unavailable",
                message: "Local diagnostics are unavailable.",
            });
        }
    },
};

export const computerPingCommand: ComputerCommand = {
    kind: COMPUTER_PING_KIND,
    handle: ({ socket }, message): void => {
        if (message.kind !== COMPUTER_PING_KIND) {
            throw new Error("Command kind mismatch");
        }
        send(socket, { kind: COMPUTER_PONG_KIND, requestId: message.requestId });
    },
};
