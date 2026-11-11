import {
    AGENT_CATALOG_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    COMPUTER_HEARTBEAT_ACK_KIND,
    COMPUTER_LIVENESS_READY_KIND,
    COMPUTER_PING_KIND,
    CONTENT_COMMIT_KIND,
    CONTENT_WRITE_KIND,
    decodeComputerDiagnosticsResult,
    decodeComputerPongEvent,
    decodeNativeSessionResult,
    decodeSessionArchivedEvent,
    decodeSessionClosedEvent,
    decodeSessionConfigReadResult,
    decodeSessionConfigUpdatedEvent,
    decodeSessionHistoryWirePageLoaded,
    decodeSessionInteractionAnsweredEvent,
    decodeSessionPreviewHistoryWirePageLoaded,
    decodeSessionPromptAcceptedEvent,
    decodeSessionPromptSteeredEvent,
    decodeSessionReadyEvent,
    decodeSessionRenamedEvent,
    decodeSessionRestoredEvent,
    decodeSessionsListedEvent,
    decodeSessionsQueriedEvent,
    decodeSessionTurnStoppedEvent,
    decodeSessionTurnWithdrawnEvent,
    FILE_READ_KIND,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    type NativeSessionRequest,
    SESSION_ARCHIVE_KIND,
    SESSION_CANCEL_BEFORE_START_KIND,
    SESSION_CANCEL_KIND,
    SESSION_CLOSE_KIND,
    SESSION_CONFIG_READ_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_CREATE_KIND,
    SESSION_CREATION_READ_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_HISTORY_PAGE_LOAD_KIND,
    SESSION_LIST_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_KIND,
    SESSION_QUERY_KIND,
    SESSION_RENAME_KIND,
    SESSION_RESTORE_KIND,
    type ServiceToDaemonMessage,
    WORKSPACE_LIST_KIND,
} from "@morty-build/client/protocol";
import { ProjectPermission } from "../../management/entity/project-authentication.ts";
import type { ComputerControlCommand, ComputerControlResult } from "./computer-control-request.ts";

/** The Computer's reply to one control command, which names the command's own request identifier. */
interface ComputerControlReply {
    readonly eventKind: ComputerControlResult["kind"];
    readonly decode: (data: string) => ComputerControlResult;
}

interface ComputerControlDefinition {
    readonly permission: ProjectPermission | ((command: ComputerControlCommand) => ProjectPermission);
    readonly reply: ComputerControlReply;
}

function directReply<K extends ComputerControlResult["kind"]>(
    eventKind: K,
    decode: (data: string) => Extract<ComputerControlResult, { readonly kind: NoInfer<K> }>,
) {
    return { eventKind, decode } satisfies ComputerControlReply;
}

/** Code-owned command policy; callers must still authorize the selected permission. */
export const computerControlRegistry = {
    "computer.diagnostics.read": {
        permission: ProjectPermission.ComputerRead,
        reply: directReply("computer.diagnostics.result", decodeComputerDiagnosticsResult),
    },
    "computer.ping": {
        permission: ProjectPermission.ComputerRead,
        reply: directReply("computer.pong", decodeComputerPongEvent),
    },
    "native.session.request": {
        permission: (command: ComputerControlCommand) =>
            command.kind === "native.session.request"
                ? nativeSessionRequestPermission(command.action)
                : ProjectPermission.SessionWrite,
        reply: directReply("native.session.result", decodeNativeSessionResult),
    },
    "session.prepare": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.ready", decodeSessionReadyEvent),
    },
    "session.create": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.ready", decodeSessionReadyEvent),
    },
    "session.creation.read": {
        permission: ProjectPermission.ComputerRead,
        reply: directReply("session.ready", decodeSessionReadyEvent),
    },
    "session.configure": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.config.updated", decodeSessionConfigUpdatedEvent),
    },
    "session.config.read": {
        permission: ProjectPermission.ComputerRead,
        reply: directReply("session.config.read.result", decodeSessionConfigReadResult),
    },
    "session.rename": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.renamed", decodeSessionRenamedEvent),
    },
    "session.close": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.closed", decodeSessionClosedEvent),
    },
    "session.archive": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.archived", decodeSessionArchivedEvent),
    },
    "session.cancel-before-start": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.turn.withdrawn", decodeSessionTurnWithdrawnEvent),
    },
    "session.cancel": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.turn.stopped", decodeSessionTurnStoppedEvent),
    },
    "session.prompt.disposition": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.prompt.steered", decodeSessionPromptSteeredEvent),
    },
    "session.prompt": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.prompt.accepted", decodeSessionPromptAcceptedEvent),
    },
    "session.preview-history.page.load": {
        permission: ProjectPermission.ComputerRead,
        reply: directReply("session.preview-history.page.loaded", decodeSessionPreviewHistoryWirePageLoaded),
    },
    "session.live-history.v2.page.load": {
        permission: ProjectPermission.SessionRead,
        reply: directReply("session.live-history.v2.page.loaded", decodeSessionHistoryWirePageLoaded),
    },
    "session.elicitation.respond": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.interaction.answered", decodeSessionInteractionAnsweredEvent),
    },
    "session.permission.respond": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.interaction.answered", decodeSessionInteractionAnsweredEvent),
    },
    "session.list": {
        permission: ProjectPermission.ComputerRead,
        reply: directReply("session.listed", decodeSessionsListedEvent),
    },
    "session.query": {
        permission: ProjectPermission.ComputerRead,
        reply: directReply("session.queried", decodeSessionsQueriedEvent),
    },
    "session.restore": {
        permission: ProjectPermission.SessionWrite,
        reply: directReply("session.restored", decodeSessionRestoredEvent),
    },
} satisfies { readonly [K in ComputerControlCommand["kind"]]: ComputerControlDefinition };

/**
 * Listing reads every native session the Computer can see, and reading the active Turn reads one Session's execution.
 * Every other native request acts on the Agent's sessions.
 */
export function nativeSessionRequestPermission(action: NativeSessionRequest["action"]): ProjectPermission {
    switch (action) {
        case "list":
            return ProjectPermission.ComputerRead;
        case "active-turn":
            return ProjectPermission.SessionRead;
        case "find":
        case "import":
        case "fork":
            return ProjectPermission.SessionWrite;
        default:
            return action satisfies never;
    }
}

export function computerControlPermission(command: ComputerControlCommand): ProjectPermission {
    const { permission } = computerControlRegistry[command.kind];
    return typeof permission === "function" ? permission(command) : permission;
}

/**
 * What a credential must grant to send this message to a Computer, however it reaches the Relay: an HTTP route and a
 * host connection apply the same answer. Null for messages only the Relay itself sends to a daemon.
 */
export function computerCommandPermission(message: ServiceToDaemonMessage): ProjectPermission | null {
    switch (message.kind) {
        case "computer.diagnostics.read":
        case COMPUTER_PING_KIND:
        case NATIVE_SESSION_REQUEST_KIND:
        case SESSION_PREPARE_KIND:
        case SESSION_CREATE_KIND:
        case SESSION_CREATION_READ_KIND:
        case SESSION_CONFIGURE_KIND:
        case SESSION_CONFIG_READ_KIND:
        case SESSION_RENAME_KIND:
        case SESSION_CLOSE_KIND:
        case SESSION_ARCHIVE_KIND:
        case SESSION_CANCEL_BEFORE_START_KIND:
        case SESSION_CANCEL_KIND:
        case SESSION_PROMPT_DISPOSITION_KIND:
        case SESSION_PROMPT_KIND:
        case SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND:
        case SESSION_HISTORY_PAGE_LOAD_KIND:
        case SESSION_ELICITATION_RESPOND_KIND:
        case SESSION_PERMISSION_RESPOND_KIND:
        case SESSION_LIST_KIND:
        case SESSION_QUERY_KIND:
        case SESSION_RESTORE_KIND:
            return computerControlPermission(message);
        case AGENT_CATALOG_DISCOVER_KIND:
        case AGENT_SETTINGS_DISCOVER_KIND:
        case WORKSPACE_LIST_KIND:
            return ProjectPermission.ComputerRead;
        case FILE_READ_KIND:
            return ProjectPermission.SessionRead;
        case CONTENT_WRITE_KIND:
        case CONTENT_COMMIT_KIND:
        case NATIVE_SESSION_CANCEL_KIND:
            return ProjectPermission.SessionWrite;
        case COMPUTER_HEARTBEAT_ACK_KIND:
        case COMPUTER_LIVENESS_READY_KIND:
            return null;
        default:
            return message satisfies never;
    }
}
