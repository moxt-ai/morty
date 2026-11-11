import { sameNativeSession } from "@morty-build/client/native-session";
import {
    AGENT_CATALOG_DISCOVERED_KIND,
    AGENT_CATALOG_DISCOVERY_FAILED_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
    type AgentSettingsDiscoverCommand,
    COMPUTER_HEARTBEAT_ACK_KIND,
    COMPUTER_LIVENESS_READY_KIND,
    COMPUTER_PONG_KIND,
    COMPUTER_STATUS_KIND,
    CONTENT_AVAILABLE_KIND,
    CONTENT_READY_KIND,
    type DaemonToRelayMessage,
    type DaemonToServiceMessage,
    decodeContentChunkFrame,
    decodeKnownServiceToDaemonMessage,
    encodeAgentSettingsDiscoveryFailedEvent,
    encodeComputerStatusEvent,
    encodeServiceToDaemonMessage,
    encodeSessionOperationFailedEvent,
    FILE_BEGIN_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    NATIVE_SESSION_RESULT_KIND,
    type NativeSessionTarget,
    ProtocolMessageError,
    readNativeSessionTarget,
    requestReplyAddress,
    SESSION_ARCHIVED_KIND,
    SESSION_CLOSE_NOTICE_KIND,
    SESSION_CLOSED_KIND,
    SESSION_CONFIG_READ_RESULT_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_EVENT_KIND,
    SESSION_HISTORY_PAGE_LOAD_KIND,
    SESSION_HISTORY_PAGE_LOADED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_LISTED_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
    SESSION_PROMPT_ACCEPTED_KIND,
    SESSION_PROMPT_KIND,
    SESSION_QUERIED_KIND,
    SESSION_READY_KIND,
    SESSION_RENAMED_KIND,
    SESSION_RESTORED_KIND,
    SESSION_STATUS_CHANGED_KIND,
    type ServiceToDaemonMessage,
    type ServiceToDaemonRequest,
    type SessionPromptCommand,
    WORKSPACE_ENTRIES_KIND,
} from "@morty-build/client/protocol";
import { SessionRuntimeError } from "../../../../contracts/relay/session.ts";
import { logger } from "../../../../infra/logger.ts";
import { SessionLiveEventRelay } from "./session-live-event-relay.ts";

function sessionErrorCloseCode(error: SessionRuntimeError): 1008 | 1013 {
    if (error.code === "session_busy") {
        return 1013;
    }
    return 1008;
}

function copyBinaryFrame(value: unknown): ArrayBuffer {
    if (value instanceof ArrayBuffer) {
        return value.slice(0);
    }
    if (ArrayBuffer.isView(value)) {
        // Copy the view's bytes: its buffer may be shared or larger than the view.
        const copy = new ArrayBuffer(value.byteLength);
        new Uint8Array(copy).set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        return copy;
    }
    throw new ProtocolMessageError("Content chunk must be binary");
}

function knownChunk(value: unknown, skipped: () => void) {
    try {
        return decodeContentChunkFrame(value);
    } catch {
        skipped();
        return null;
    }
}

export type HistoryRequestKind = "live" | "preview";

export interface RelaySocket {
    readonly sessionFilter?: NativeSessionTarget | undefined;
    readonly close: (code: number, reason: string) => void;
    readonly consumeAgentSettingsDiscovery: (requestId: string, harness: string) => boolean;
    readonly consumeAgentSettingsDiscoveryFailure: (requestId: string) => boolean;
    readonly takeAgentSettingsDiscoveries: () => readonly string[];
    readonly bindHistoryRequest: (kind: HistoryRequestKind, requestId: string) => void;
    readonly matchesHistoryRequest: (kind: HistoryRequestKind, requestId: string) => boolean;
    readonly isOpen: () => boolean;
    readonly isSame: (socket: RelaySocket) => boolean;
    readonly permitsSessionHistory: () => boolean;
    readonly send: (message: string | ArrayBuffer) => void;
    readonly trackAgentSettingsDiscovery: (requestId: string, harness: string) => "tracked" | "duplicate" | "busy";
}

export interface RelayPeers {
    readonly viewers: () => readonly {
        readonly socket: RelaySocket;
        readonly target: NativeSessionTarget;
        readonly expiresAt: number;
    }[];
    readonly operations: () => readonly {
        readonly socket: RelaySocket;
        readonly requestId: string;
        readonly target: NativeSessionTarget | undefined;
    }[];
    readonly daemons: () => readonly RelaySocket[];
    readonly hosts: () => readonly RelaySocket[];
    readonly nativeRequests: () => readonly { readonly requestId: string; readonly socket: RelaySocket }[];
    readonly historyRecipients: () => readonly RelaySocket[];
}

export class ComputerRelayActor {
    #lastSkippedLogAt = Number.NEGATIVE_INFINITY;
    #skippedCount = 0;

    readonly recordSkipped = (reason: string): void => {
        this.#skippedCount += 1;
        const now = Date.now();
        if (now - this.#lastSkippedLogAt < 60_000) {
            return;
        }
        logger.warn(
            {
                event: "relay_message_skipped",
                reason,
                skippedCount: this.#skippedCount,
                computerId: this.#computerId,
            },
            "Relay skipped unsupported input",
        );
        this.#lastSkippedLogAt = now;
        this.#skippedCount = 0;
    };
    readonly #peers: RelayPeers;
    readonly #computerId: string;
    readonly #liveEvents: SessionLiveEventRelay;

    constructor(cx: {
        readonly config: { readonly computerId: string };
        readonly gateways: {
            readonly peers: RelayPeers;
        };
    }) {
        const { computerId } = cx.config;
        const { peers } = cx.gateways;
        this.#peers = peers;
        this.#computerId = computerId;
        this.#liveEvents = new SessionLiveEventRelay(peers);
    }

    readonly attachDaemon = async (replacedExistingConnection: boolean, _signal: AbortSignal): Promise<void> => {
        if (replacedExistingConnection) {
            this.failPendingAgentSettingsDiscoveries();
        }
        this.broadcastComputerStatus(true);
    };

    readonly attachHost = (socket: RelaySocket, _signal: AbortSignal): Promise<void> => {
        socket.send(
            encodeComputerStatusEvent({
                kind: COMPUTER_STATUS_KIND,
                online: this.hasOnlineDaemon(),
                computerId: this.#computerId,
            }),
        );
        return Promise.resolve();
    };

    readonly detachDaemon = async (socket: RelaySocket, _signal: AbortSignal): Promise<void> => {
        const anotherDaemonOnline = this.#peers
            .daemons()
            .some((candidate) => !candidate.isSame(socket) && candidate.isOpen());
        if (anotherDaemonOnline) {
            return;
        }
        this.failPendingAgentSettingsDiscoveries();
        this.broadcastComputerStatus(false);
    };

    readonly receiveDaemonMessage = async (
        socket: RelaySocket,
        message: DaemonToRelayMessage | null,
        signal: AbortSignal,
        encoded?: string,
    ): Promise<void> => {
        try {
            if (message === null) {
                if (encoded === undefined) {
                    this.recordSkipped("missing_daemon_payload");
                    return;
                }
                let value: unknown;
                try {
                    value = JSON.parse(encoded);
                } catch {
                    this.recordSkipped("invalid_daemon_json");
                    return;
                }
                if (typeof value !== "object" || value === null || Array.isArray(value)) {
                    this.recordSkipped("unsupported_daemon_envelope");
                    return;
                }
                const parsed = readNativeSessionTarget(Reflect.get(value, "target"));
                const kind: unknown = Reflect.get(value, "kind");
                if (typeof kind !== "string" || kind.length === 0 || kind.length > 64 || parsed === null) {
                    this.recordSkipped("unroutable_daemon_message");
                    return;
                }
                // The authenticated daemon owns its output. Unknown payloads can
                // reach only hosts subscribed to their explicit Session.
                const requestId: unknown = Reflect.get(value, "requestId");
                this.broadcast(
                    [
                        ...this.#peers.hosts(),
                        ...this.#peers
                            .operations()
                            .filter(
                                (route) =>
                                    route.requestId === requestId &&
                                    route.target !== undefined &&
                                    sameNativeSession(route.target, parsed),
                            )
                            .map((route) => route.socket),
                    ],
                    encoded,
                    parsed,
                );
                return;
            }
            const wire = encoded ?? JSON.stringify(message);
            const kind = message.kind;
            if (kind === SESSION_EVENT_KIND) {
                this.#liveEvents.receive(message);
                return;
            }
            if (kind === SESSION_CLOSE_NOTICE_KIND) {
                this.broadcast(
                    this.#peers
                        .viewers()
                        .filter(
                            (viewer) =>
                                viewer.expiresAt > Date.now() && sameNativeSession(viewer.target, message.target),
                        )
                        .map((viewer) => viewer.socket),
                    wire,
                );
            }
            if (kind === SESSION_INFO_UPDATED_KIND) {
                this.broadcast(
                    this.#peers.hosts(),
                    JSON.stringify({ ...JSON.parse(wire), computerId: this.#computerId }),
                    message.target,
                );
                return;
            }
            if (
                kind === NATIVE_SESSION_RESULT_KIND ||
                kind === SESSION_OPERATION_FAILED_KIND ||
                kind === SESSION_PROMPT_ACCEPTED_KIND
            ) {
                this.broadcast(
                    [
                        ...this.#peers.hosts(),
                        ...this.#peers
                            .operations()
                            .filter((route) => route.requestId === message.requestId)
                            .map(({ socket }) => socket),
                        ...this.#peers
                            .nativeRequests()
                            .filter(({ requestId }) => requestId === message.requestId)
                            .map(({ socket }) => socket),
                    ],
                    wire,
                    "target" in message ? message.target : undefined,
                );
                return;
            }
            if (kind === AGENT_SETTINGS_DISCOVERED_KIND) {
                this.returnAgentSettingsDiscoveryResult(message.requestId, message.harness, wire);
                return;
            }
            if (kind === AGENT_SETTINGS_DISCOVERY_FAILED_KIND) {
                this.returnAgentSettingsDiscoveryFailure(message.requestId, wire);
                return;
            }
            if (kind === SESSION_HISTORY_PAGE_LOADED_KIND) {
                this.returnHistoryPage("live", message);
                return;
            }
            if (kind === SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND) {
                this.returnHistoryPage("preview", message);
                return;
            }
            this.validateDaemonControl(message);
            if ("requestId" in message) {
                this.broadcast(
                    this.#peers
                        .operations()
                        .filter((route) => route.requestId === message.requestId)
                        .map(({ socket }) => socket),
                    wire,
                );
            }
            const target = readNativeSessionTarget("target" in message ? message.target : undefined);
            this.broadcast(this.#peers.hosts(), wire, target ?? undefined);
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            if (error instanceof SessionRuntimeError) {
                socket.close(sessionErrorCloseCode(error), error.code);
                return;
            }
            socket.close(
                error instanceof ProtocolMessageError ? 1008 : 1011,
                error instanceof ProtocolMessageError ? "Invalid protocol message" : "Session storage unavailable",
            );
        }
    };

    readonly receiveDaemonChunk = (_socket: RelaySocket, message: unknown): void => {
        const chunk = knownChunk(message, () => this.recordSkipped("unsupported_daemon_frame"));
        if (chunk === null) {
            return;
        }
        const recipient = this.#peers
            .operations()
            .find((route) => route.requestId === chunk.requestId && route.socket.isOpen())?.socket;
        if (recipient === undefined) {
            // The HTTP caller can cancel after the daemon has already queued its next
            // chunk. The operation route is gone by the time that frame arrives, but
            // this is not a daemon protocol violation and must not interrupt unrelated
            // Sessions sharing the Computer connection.
            return;
        }
        recipient.send(copyBinaryFrame(message));
    };

    readonly receiveHostChunk = (socket: RelaySocket, message: unknown): void => {
        const chunk = knownChunk(message, () => this.recordSkipped("unsupported_host_frame"));
        if (chunk === null) {
            return;
        }
        const ownsOperation = this.#peers
            .operations()
            .some((route) => route.requestId === chunk.requestId && route.socket.isSame(socket));
        if (!ownsOperation) {
            throw new ProtocolMessageError("Content chunk does not belong to this operation");
        }
        const daemon = this.#peers.daemons().find((candidate) => candidate.isOpen());
        if (daemon === undefined) {
            throw new SessionRuntimeError("computer_offline", "The local computer is offline");
        }
        daemon.send(copyBinaryFrame(message));
    };

    readonly receiveHostMessage = async (socket: RelaySocket, message: unknown, signal: AbortSignal): Promise<void> => {
        if (typeof message !== "string" || message.length > 8 * 1024 * 1024) {
            socket.close(1003, "Bounded text message required");
            return;
        }
        try {
            const command = decodeKnownServiceToDaemonMessage(message);
            if (command === null) {
                this.recordSkipped("unsupported_host_message");
                return;
            }
            switch (command.kind) {
                case SESSION_PROMPT_KIND:
                    this.forwardPrompt(socket, command, message);
                    return;
                case AGENT_SETTINGS_DISCOVER_KIND:
                    this.forwardAgentSettingsDiscovery(socket, command, message);
                    return;
                case SESSION_HISTORY_PAGE_LOAD_KIND:
                    if (!socket.permitsSessionHistory()) {
                        throw new ProtocolMessageError("Live Session history requires an internal connection");
                    }
                    this.forwardHistoryPage(socket, "live", command, message);
                    return;
                case SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND:
                    if (!socket.permitsSessionHistory()) {
                        throw new ProtocolMessageError("Session preview history requires an internal connection");
                    }
                    this.forwardHistoryPage(socket, "preview", command, message);
                    return;
                case COMPUTER_HEARTBEAT_ACK_KIND:
                case COMPUTER_LIVENESS_READY_KIND:
                    // Liveness belongs to the daemon's own connection; a host has none to signal.
                    return;
                default:
                    this.forwardControl(socket, command, message);
                    return;
            }
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            if (error instanceof SessionRuntimeError) {
                socket.close(sessionErrorCloseCode(error), error.code);
                return;
            }
            socket.close(1008, "Invalid protocol message");
        }
    };

    private readonly validateDaemonControl = (message: DaemonToServiceMessage): void => {
        switch (message.kind) {
            case AGENT_SETTINGS_DISCOVERED_KIND:
                return;
            case AGENT_SETTINGS_DISCOVERY_FAILED_KIND:
                return;
            case AGENT_CATALOG_DISCOVERED_KIND:
                return;
            case AGENT_CATALOG_DISCOVERY_FAILED_KIND:
                return;
            case FILE_BEGIN_KIND:
                return;
            case FILE_END_KIND:
                return;
            case FILE_FAILED_KIND:
                return;
            case CONTENT_READY_KIND:
                return;
            case CONTENT_AVAILABLE_KIND:
                return;
            case SESSION_QUERIED_KIND:
                return;
            case SESSION_RESTORED_KIND:
                return;
            case SESSION_CLOSED_KIND:
                return;
            case SESSION_ARCHIVED_KIND:
                return;
            case SESSION_CLOSE_NOTICE_KIND:
                return;
            case SESSION_LISTED_KIND:
                return;
            case SESSION_CONFIG_UPDATED_KIND:
                return;
            case SESSION_CONFIG_READ_RESULT_KIND:
                return;
            case SESSION_RENAMED_KIND:
                return;
            case SESSION_STATUS_CHANGED_KIND:
                return;
            case NATIVE_SESSION_RESULT_KIND:
                return;
            case WORKSPACE_ENTRIES_KIND:
                return;
            case "computer.diagnostics.result":
            case COMPUTER_PONG_KIND:
                return;
            case SESSION_OPERATION_FAILED_KIND:
                return;
            case SESSION_READY_KIND:
                return;
            default:
                return;
        }
    };

    /** Sends a request to the daemon and lets the hosts watching its Session observe it. */
    private readonly forwardControl = (socket: RelaySocket, command: ServiceToDaemonRequest, encoded: string): void => {
        if (!this.sendToDaemon(command, encoded)) {
            this.refuseOffline(socket, command);
            return;
        }
        this.broadcast(this.#peers.hosts(), encoded, "target" in command ? command.target : undefined);
    };

    private readonly forwardPrompt = (socket: RelaySocket, command: SessionPromptCommand, encoded: string): void => {
        if (!this.sendToDaemon(command, encoded)) {
            this.refuseOffline(socket, command);
        }
    };

    /** Answers a request the daemon cannot receive at the address every answer to that request carries. */
    private readonly refuseOffline = (socket: RelaySocket, command: ServiceToDaemonRequest): void => {
        const target = "target" in command ? command.target : undefined;
        socket.send(
            encodeSessionOperationFailedEvent({
                code: "computer_offline",
                kind: SESSION_OPERATION_FAILED_KIND,
                message: "The local computer is offline",
                requestId: requestReplyAddress(command),
                ...(target === undefined ? {} : { target }),
            }),
        );
    };

    private readonly forwardAgentSettingsDiscovery = (
        socket: RelaySocket,
        command: AgentSettingsDiscoverCommand,
        encoded: string,
    ): void => {
        const { harness } = command;
        const requestId = requestReplyAddress(command);
        const route = socket.trackAgentSettingsDiscovery(requestId, harness);
        if (route === "duplicate") {
            return;
        }
        if (route === "busy") {
            socket.send(
                encodeAgentSettingsDiscoveryFailedEvent({
                    code: "agent_settings_discovery_busy",
                    kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                    message: "This connection already has pending settings discovery requests",
                    requestId,
                }),
            );
            return;
        }
        if (!this.sendToDaemon(command, encoded)) {
            socket.consumeAgentSettingsDiscoveryFailure(requestId);
            socket.send(
                encodeAgentSettingsDiscoveryFailedEvent({
                    code: "computer_offline",
                    kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                    message: "The local computer is offline",
                    requestId,
                }),
            );
            return;
        }
    };

    private readonly returnAgentSettingsDiscoveryResult = (
        requestId: string,
        harness: string,
        message: string,
    ): void => {
        const recipient = [...this.#peers.hosts(), ...this.#peers.operations().map(({ socket }) => socket)].find(
            (socket) => socket.consumeAgentSettingsDiscovery(requestId, harness),
        );
        if (recipient?.isOpen()) {
            recipient.send(message);
        }
    };

    private readonly returnAgentSettingsDiscoveryFailure = (requestId: string, message: string): void => {
        const recipient = [...this.#peers.hosts(), ...this.#peers.operations().map(({ socket }) => socket)].find(
            (socket) => socket.consumeAgentSettingsDiscoveryFailure(requestId),
        );
        if (recipient?.isOpen()) {
            recipient.send(message);
        }
    };

    private readonly returnHistoryPage = (
        kind: HistoryRequestKind,
        message: Extract<
            DaemonToRelayMessage,
            {
                readonly kind:
                    | typeof SESSION_HISTORY_PAGE_LOADED_KIND
                    | typeof SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND;
            }
        >,
    ): void => {
        const recipient = this.#peers
            .historyRecipients()
            .find((socket) => socket.isOpen() && socket.matchesHistoryRequest(kind, message.requestId));
        // A caller can close or time out independently of the authenticated daemon.
        recipient?.send(JSON.stringify(message));
    };

    private readonly forwardHistoryPage = (
        socket: RelaySocket,
        kind: HistoryRequestKind,
        command: Extract<
            ServiceToDaemonMessage,
            {
                readonly kind: typeof SESSION_HISTORY_PAGE_LOAD_KIND | typeof SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND;
            }
        >,
        encoded: string,
    ): void => {
        // Internal history connections belong to one operation; only its reply address survives hibernation.
        socket.bindHistoryRequest(kind, requestReplyAddress(command));
        if (!this.sendToDaemon(command, encoded)) {
            socket.close(1013, "Computer offline");
        }
    };

    private readonly failPendingAgentSettingsDiscoveries = (): void => {
        for (const socket of [...this.#peers.hosts(), ...this.#peers.operations().map(({ socket }) => socket)]) {
            for (const requestId of socket.takeAgentSettingsDiscoveries()) {
                if (socket.isOpen()) {
                    socket.send(
                        encodeAgentSettingsDiscoveryFailedEvent({
                            code: "computer_offline",
                            kind: AGENT_SETTINGS_DISCOVERY_FAILED_KIND,
                            message: "The local computer is offline",
                            requestId,
                        }),
                    );
                }
            }
        }
    };

    private readonly sendToDaemon = (message: ServiceToDaemonMessage, encoded?: string): boolean => {
        const daemon = this.#peers.daemons().find((socket) => socket.isOpen());
        if (daemon === undefined) {
            return false;
        }
        try {
            daemon.send(encoded ?? encodeServiceToDaemonMessage(message));
            return true;
        } catch {
            return false;
        }
    };

    private readonly hasOnlineDaemon = (): boolean => this.#peers.daemons().some((socket) => socket.isOpen());

    private readonly broadcastComputerStatus = (online: boolean): void => {
        if (!online) {
            for (const { socket } of this.#peers.viewers()) {
                socket.close(1000, "Computer offline");
            }
        }
        this.broadcast(
            [
                ...this.#peers.hosts(),
                ...this.#peers.operations().map(({ socket }) => socket),
                ...this.#peers.nativeRequests().map(({ socket }) => socket),
            ],
            encodeComputerStatusEvent({ kind: COMPUTER_STATUS_KIND, online, computerId: this.#computerId }),
        );
    };

    private readonly broadcast = (
        sockets: readonly RelaySocket[],
        message: string,
        target?: NativeSessionTarget,
    ): void => {
        for (const socket of sockets) {
            if (
                target !== undefined &&
                socket.sessionFilter !== undefined &&
                !sameNativeSession(socket.sessionFilter, target)
            ) {
                continue;
            }
            if (socket.isOpen()) {
                socket.send(message);
            }
        }
    };
}
