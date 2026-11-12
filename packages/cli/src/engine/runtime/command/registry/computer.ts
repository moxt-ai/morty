import { type COMPUTER_PING_KIND, COMPUTER_PONG_KIND } from "@morty-build/client/protocol";
import packageMetadata from "../../../../../package.json" with { type: "json" };
import { runtimeEnvironmentDiagnostics } from "../../observability/environment-diagnostics.ts";
import type { CommandHandler } from "../definition.ts";
import { send } from "../transport.ts";

export const handleComputerDiagnostics: CommandHandler<"computer.diagnostics.read"> = (
    { config, diagnostics, socket },
    message,
): void => {
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
};

export const handleComputerPing: CommandHandler<typeof COMPUTER_PING_KIND> = ({ socket }, message): void => {
    send(socket, { kind: COMPUTER_PONG_KIND, requestId: message.requestId });
};
