import { COMPUTER_PING_KIND, COMPUTER_PONG_KIND } from "@morty-build/client/protocol";
import packageMetadata from "../../../../../package.json" with { type: "json" };
import { runtimeEnvironmentDiagnostics } from "../../observability/environment-diagnostics.ts";
import type { RuntimeCommand } from "../definition.ts";
import { send } from "../transport.ts";

export const computerDiagnosticsCommand: RuntimeCommand = {
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
                ...diagnostics.snapshot(runtimeEnvironmentDiagnostics(config)),
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

export const computerPingCommand: RuntimeCommand = {
    kind: COMPUTER_PING_KIND,
    handle: ({ socket }, message): void => {
        if (message.kind !== COMPUTER_PING_KIND) {
            throw new Error("Command kind mismatch");
        }
        send(socket, { kind: COMPUTER_PONG_KIND, requestId: message.requestId });
    },
};
