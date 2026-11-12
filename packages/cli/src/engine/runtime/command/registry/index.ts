import { decodeContentChunkFrame, type ServiceToDaemonRequest } from "@morty-build/client/protocol";
import { createAgentSettingsDiscoveryHandler } from "../agent-settings-discovery.ts";
import type { CommandContext } from "../context.ts";
import { createNativeSessionRequestHandler } from "../native-session-requests.ts";
import { handleComputerDiagnostics, handleComputerPing } from "./computer.ts";
import { createContentWriteCommands } from "./content-write/index.ts";
import { handleFileRead } from "./file-read/index.ts";
import { handlePreviewHistoryPageLoad, handleSessionHistoryPageLoad } from "./history.ts";
import {
    handleElicitationRespond,
    handlePermissionRespond,
    handlePromptDisposition,
    handleSessionArchive,
    handleSessionCancel,
    handleSessionCancelBeforeStart,
    handleSessionClose,
} from "./interactions.ts";
import { handleSessionList, handleSessionQuery } from "./native-sessions.ts";
import { handleSessionPrompt } from "./prompt.ts";
import {
    handleSessionConfigRead,
    handleSessionConfigure,
    handleSessionCreate,
    handleSessionPrepare,
    handleSessionRename,
    handleSessionRestore,
    handleWorkspaceList,
} from "./session.ts";

export function createCommandRegistry(context: CommandContext): {
    readonly dispatch: (message: ServiceToDaemonRequest) => void;
    readonly dispatchChunk: (message: unknown) => void;
    readonly settle: () => Promise<void>;
} {
    const contentWrites = createContentWriteCommands(context);
    const nativeRequests = createNativeSessionRequestHandler(context);
    const agentSettings = createAgentSettingsDiscoveryHandler(context);
    return {
        dispatch: (message): void => {
            switch (message.kind) {
                case "computer.diagnostics.read":
                    handleComputerDiagnostics(context, message);
                    return;
                case "computer.ping":
                    handleComputerPing(context, message);
                    return;
                case "session.live-history.v2.page.load":
                    handleSessionHistoryPageLoad(context, message);
                    return;
                case "session.preview-history.page.load":
                    handlePreviewHistoryPageLoad(context, message);
                    return;
                case "native.session.cancel":
                    nativeRequests.cancel(message);
                    return;
                case "native.session.request":
                    nativeRequests.handle(message);
                    return;
                case "session.list":
                    handleSessionList(context, message);
                    return;
                case "session.query":
                    handleSessionQuery(context, message);
                    return;
                case "agent.settings.discover":
                    agentSettings.handle(message);
                    return;
                case "content.write":
                    contentWrites.write(message);
                    return;
                case "content.commit":
                    contentWrites.commit(message);
                    return;
                case "file.read":
                    handleFileRead(context, message);
                    return;
                case "session.cancel-before-start":
                    handleSessionCancelBeforeStart(context, message);
                    return;
                case "session.cancel":
                    handleSessionCancel(context, message);
                    return;
                case "session.close":
                    handleSessionClose(context, message);
                    return;
                case "session.archive":
                    handleSessionArchive(context, message);
                    return;
                case "session.prompt.disposition":
                    handlePromptDisposition(context, message);
                    return;
                case "workspace.list":
                    handleWorkspaceList(context, message);
                    return;
                case "session.prepare":
                    handleSessionPrepare(context, message);
                    return;
                case "session.create":
                    handleSessionCreate(context, message);
                    return;
                case "session.configure":
                    handleSessionConfigure(context, message);
                    return;
                case "session.config.read":
                    handleSessionConfigRead(context, message);
                    return;
                case "session.rename":
                    handleSessionRename(context, message);
                    return;
                case "session.restore":
                    handleSessionRestore(context, message);
                    return;
                case "session.permission.respond":
                    handlePermissionRespond(context, message);
                    return;
                case "session.elicitation.respond":
                    handleElicitationRespond(context, message);
                    return;
                case "session.prompt":
                    handleSessionPrompt(context, message);
                    return;
                default:
                    message satisfies never;
            }
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
            await Promise.all([contentWrites.settle(), nativeRequests.settle(), agentSettings.settle()]);
        },
    };
}
