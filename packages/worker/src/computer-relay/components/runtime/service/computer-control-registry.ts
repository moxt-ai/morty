import {
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
} from "@morty-build/client/protocol";
import type { ComputerControlCommand, ComputerControlResult } from "./computer-control-request.ts";

/** The Computer's reply to one control command, which names the command's own request identifier. */
interface ComputerControlReply {
    readonly eventKind: ComputerControlResult["kind"];
    readonly decode: (data: string) => ComputerControlResult;
}

function directReply<K extends ComputerControlResult["kind"]>(
    eventKind: K,
    decode: (data: string) => Extract<ComputerControlResult, { readonly kind: NoInfer<K> }>,
) {
    return { eventKind, decode } satisfies ComputerControlReply;
}

/** The reply that answers each control command. */
export const computerControlRegistry = {
    "computer.diagnostics.read": directReply("computer.diagnostics.result", decodeComputerDiagnosticsResult),
    "computer.ping": directReply("computer.pong", decodeComputerPongEvent),
    "native.session.request": directReply("native.session.result", decodeNativeSessionResult),
    "session.prepare": directReply("session.ready", decodeSessionReadyEvent),
    "session.create": directReply("session.ready", decodeSessionReadyEvent),
    "session.creation.read": directReply("session.ready", decodeSessionReadyEvent),
    "session.configure": directReply("session.config.updated", decodeSessionConfigUpdatedEvent),
    "session.config.read": directReply("session.config.read.result", decodeSessionConfigReadResult),
    "session.rename": directReply("session.renamed", decodeSessionRenamedEvent),
    "session.close": directReply("session.closed", decodeSessionClosedEvent),
    "session.archive": directReply("session.archived", decodeSessionArchivedEvent),
    "session.cancel-before-start": directReply("session.turn.withdrawn", decodeSessionTurnWithdrawnEvent),
    "session.cancel": directReply("session.turn.stopped", decodeSessionTurnStoppedEvent),
    "session.prompt.disposition": directReply("session.prompt.steered", decodeSessionPromptSteeredEvent),
    "session.prompt": directReply("session.prompt.accepted", decodeSessionPromptAcceptedEvent),
    "session.preview-history.page.load": directReply(
        "session.preview-history.page.loaded",
        decodeSessionPreviewHistoryWirePageLoaded,
    ),
    "session.live-history.v2.page.load": directReply(
        "session.live-history.v2.page.loaded",
        decodeSessionHistoryWirePageLoaded,
    ),
    "session.elicitation.respond": directReply("session.interaction.answered", decodeSessionInteractionAnsweredEvent),
    "session.permission.respond": directReply("session.interaction.answered", decodeSessionInteractionAnsweredEvent),
    "session.list": directReply("session.listed", decodeSessionsListedEvent),
    "session.query": directReply("session.queried", decodeSessionsQueriedEvent),
    "session.restore": directReply("session.restored", decodeSessionRestoredEvent),
} satisfies { readonly [K in ComputerControlCommand["kind"]]: ComputerControlReply };
