import { decodeContentChunkFrame, type ServiceToDaemonMessage } from "@morty-build/client/protocol";
import type { CommandContext } from "../context.ts";
import type { RuntimeCommand } from "../definition.ts";
import { createAgentCatalogCommands } from "./agent-catalog.ts";
import { createAgentSettingsCommands } from "./agent-settings.ts";
import { computerDiagnosticsCommand, computerPingCommand } from "./computer.ts";
import { createContentWriteCommands } from "./content-write/index.ts";
import { fileReadCommand } from "./file-read/index.ts";
import { previewHistoryPageLoadCommand, sessionHistoryPageLoadCommand } from "./history.ts";
import {
    elicitationRespondCommand,
    permissionRespondCommand,
    promptDispositionCommand,
    sessionArchiveCommand,
    sessionCancelBeforeStartCommand,
    sessionCancelCommand,
    sessionCloseCommand,
} from "./interactions.ts";
import { createNativeSessionCommands } from "./native-sessions.ts";
import { sessionPromptCommand } from "./prompt.ts";
import {
    sessionConfigReadCommand,
    sessionConfigureCommand,
    sessionCreateCommand,
    sessionCreationReadCommand,
    sessionPrepareCommand,
    sessionRenameCommand,
    sessionRestoreCommand,
    workspaceListCommand,
} from "./session.ts";

export function createCommandRegistry(context: CommandContext): {
    readonly dispatch: (message: ServiceToDaemonMessage) => void;
    readonly dispatchChunk: (message: unknown) => void;
    readonly settle: () => Promise<void>;
} {
    const contentWrites = createContentWriteCommands(context);
    const commands: readonly RuntimeCommand[] = [
        computerDiagnosticsCommand,
        computerPingCommand,
        sessionHistoryPageLoadCommand,
        previewHistoryPageLoadCommand,
        ...createNativeSessionCommands(context),
        ...createAgentCatalogCommands(context),
        ...createAgentSettingsCommands(context),
        ...contentWrites.commands,
        fileReadCommand,
        sessionCancelBeforeStartCommand,
        sessionCancelCommand,
        sessionCloseCommand,
        sessionArchiveCommand,
        promptDispositionCommand,
        workspaceListCommand,
        sessionPrepareCommand,
        sessionCreateCommand,
        sessionCreationReadCommand,
        sessionConfigureCommand,
        sessionConfigReadCommand,
        sessionRenameCommand,
        sessionRestoreCommand,
        permissionRespondCommand,
        elicitationRespondCommand,
        sessionPromptCommand,
    ];
    return {
        dispatch: (message): void => {
            const command = commands.find((candidate) => candidate.kind === message.kind);
            if (command === undefined) {
                throw new Error("Unsupported protocol message");
            }
            command.handle(context, message);
        },
        dispatchChunk: (message): void => {
            // A future binary format must not disconnect unrelated Sessions.
            // Validate the whole frame before passing any bytes to an upload.
            const frame = (() => {
                try {
                    return decodeContentChunkFrame(message);
                } catch {
                    context.diagnostics.daemonDiagnostic("content_frame_discarded", "unknown", {
                        reason: "unsupported_frame",
                    });
                    return null;
                }
            })();
            if (frame !== null) {
                contentWrites.receiveChunk(frame);
            }
        },
        settle: async (): Promise<void> => {
            await Promise.all([
                contentWrites.settle(),
                ...commands.flatMap((command) => (command.settle === undefined ? [] : [command.settle()])),
            ]);
        },
    };
}
