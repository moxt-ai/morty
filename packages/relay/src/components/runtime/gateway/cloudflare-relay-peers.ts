import {
    decodeSessionAccessGrant,
    isIdentifier,
    type NativeSessionTarget,
    ProtocolMessageError,
} from "@morty-build/client/protocol";
import * as v from "valibot";
import type { HistoryRequestKind, RelaySocket } from "../service/computer-relay-actor.ts";
import type {
    ComputerPeers,
    ComputerSocket,
    ComputerSocketIdentity,
    DaemonHeartbeat,
} from "../service/computer-service.ts";

// Four maximum-length routes fit alongside connection identity within the attachment budget.
const MAX_SETTINGS_DISCOVERY_ROUTES = 4;

const pendingAgentSettingsDiscoverySchema = v.object({
    harness: v.pipe(v.string(), v.minLength(1)),
    requestId: v.pipe(v.string(), v.minLength(1)),
});
const historyRequestSchema = v.object({
    kind: v.picklist(["live", "preview"]),
    requestId: v.pipe(v.string(), v.minLength(1)),
});

const targetSchema = v.object({
    harness: v.pipe(
        v.string(),
        v.check((value: string) => isIdentifier(value)),
    ),
    sessionId: v.pipe(
        v.string(),
        v.check((value: string) => isIdentifier(value)),
    ),
});
const attachmentSchema = v.union([
    v.object({
        role: v.literal("viewer"),
        expiresAt: v.number(),
        credential: v.object({
            signingKeyId: v.string(),
            grant: v.pipe(v.unknown(), v.transform(decodeSessionAccessGrant)),
        }),
        computerId: v.string(),
        sessionFilter: targetSchema,
    }),
    v.object({
        role: v.literal("host"),
        nativeRequestId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
        sessionFilter: v.optional(targetSchema),

        computerId: v.string(),
        historyRequest: v.optional(historyRequestSchema),
        pendingAgentSettingsDiscoveries: v.array(pendingAgentSettingsDiscoverySchema),
    }),
    v.object({
        role: v.picklist(["daemon", "replaced-daemon"]),
        connectionEpoch: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        computerId: v.string(),
    }),
]);

export class CloudflareRelaySocket implements ComputerSocket {
    readonly #socket: WebSocket;

    constructor(socket: WebSocket) {
        this.#socket = socket;
    }

    get sessionFilter(): NativeSessionTarget | undefined {
        const identity = this.identity();
        return identity.role === "host" || identity.role === "viewer" ? identity.sessionFilter : undefined;
    }

    readonly identity = (): ComputerSocketIdentity => {
        const attachment = v.parse(attachmentSchema, this.#socket.deserializeAttachment());
        if (attachment.role === "host") {
            return {
                ...(attachment.nativeRequestId === undefined ? {} : { nativeRequestId: attachment.nativeRequestId }),
                ...(attachment.sessionFilter === undefined ? {} : { sessionFilter: attachment.sessionFilter }),
                computerId: attachment.computerId,
                role: attachment.role,
            };
        }
        if (attachment.role === "viewer") {
            return attachment;
        }
        if (attachment.role === "daemon" || attachment.role === "replaced-daemon") {
            return {
                connectionEpoch: attachment.connectionEpoch,
                computerId: attachment.computerId,
                role: attachment.role,
            };
        }
        return attachment;
    };
    readonly close = (code: number, reason: string): void => this.#socket.close(code, reason);
    readonly consumeAgentSettingsDiscovery = (requestId: string, harness: string): boolean => {
        if (this.identity().role === "viewer") {
            return false;
        }
        const attachment = this.hostAttachment();
        let consumed = false;
        const pendingAgentSettingsDiscoveries = attachment.pendingAgentSettingsDiscoveries.filter((pending) => {
            if (pending.requestId === requestId && pending.harness === harness) {
                consumed = true;
                return false;
            }
            return true;
        });
        if (consumed || pendingAgentSettingsDiscoveries.length !== attachment.pendingAgentSettingsDiscoveries.length) {
            this.#socket.serializeAttachment({ ...attachment, pendingAgentSettingsDiscoveries });
        }
        return consumed;
    };
    readonly consumeAgentSettingsDiscoveryFailure = (requestId: string): boolean => {
        if (this.identity().role === "viewer") {
            return false;
        }
        const attachment = this.hostAttachment();
        let consumed = false;
        const pendingAgentSettingsDiscoveries = attachment.pendingAgentSettingsDiscoveries.filter((pending) => {
            if (pending.requestId === requestId) {
                consumed = true;
                return false;
            }
            return true;
        });
        if (consumed || pendingAgentSettingsDiscoveries.length !== attachment.pendingAgentSettingsDiscoveries.length) {
            this.#socket.serializeAttachment({ ...attachment, pendingAgentSettingsDiscoveries });
        }
        return consumed;
    };
    readonly takeAgentSettingsDiscoveries = (): readonly string[] => {
        if (this.identity().role === "viewer") {
            return [];
        }
        const attachment = this.hostAttachment();
        const requests = attachment.pendingAgentSettingsDiscoveries.map((pending) => pending.requestId);
        if (attachment.pendingAgentSettingsDiscoveries.length > 0) {
            this.#socket.serializeAttachment({ ...attachment, pendingAgentSettingsDiscoveries: [] });
        }
        return requests;
    };
    readonly bindHistoryRequest = (kind: HistoryRequestKind, requestId: string): void => {
        const attachment = v.parse(attachmentSchema, this.#socket.deserializeAttachment());
        if (!this.permitsSessionHistory()) {
            throw new ProtocolMessageError("History replies require an internal connection");
        }
        if (attachment.role === "host") {
            if (
                attachment.historyRequest !== undefined &&
                (attachment.historyRequest.kind !== kind || attachment.historyRequest.requestId !== requestId)
            ) {
                throw new ProtocolMessageError("An internal history connection belongs to one request");
            }
            this.#socket.serializeAttachment({ ...attachment, historyRequest: { kind, requestId } });
            return;
        }
        throw new ProtocolMessageError("History replies require an internal connection");
    };
    readonly matchesHistoryRequest = (kind: HistoryRequestKind, requestId: string): boolean => {
        const attachment = v.parse(attachmentSchema, this.#socket.deserializeAttachment());
        return (
            attachment.role === "host" &&
            attachment.historyRequest?.kind === kind &&
            attachment.historyRequest.requestId === requestId
        );
    };
    readonly isOpen = (): boolean => this.#socket.readyState === WebSocket.OPEN;
    readonly isSame = (socket: RelaySocket): boolean =>
        socket instanceof CloudflareRelaySocket && socket.#socket === this.#socket;
    readonly permitsSessionHistory = (): boolean => {
        const identity = this.identity();
        // Control hosts read Session history.
        return identity.role === "host";
    };
    readonly send = (message: string | ArrayBuffer): void => this.#socket.send(message);
    readonly trackAgentSettingsDiscovery = (requestId: string, harness: string): "tracked" | "duplicate" | "busy" => {
        const attachment = this.hostAttachment();
        const existing = attachment.pendingAgentSettingsDiscoveries.find((pending) => pending.requestId === requestId);
        if (existing !== undefined) {
            return existing.harness === harness ? "duplicate" : "busy";
        }
        if (attachment.pendingAgentSettingsDiscoveries.length >= MAX_SETTINGS_DISCOVERY_ROUTES) {
            return "busy";
        }
        this.#socket.serializeAttachment({
            ...attachment,
            pendingAgentSettingsDiscoveries: [...attachment.pendingAgentSettingsDiscoveries, { harness, requestId }],
        });
        return "tracked";
    };
    readonly replaceDaemon = (): void => {
        const identity = this.identity();
        if (identity.role !== "daemon" && identity.role !== "replaced-daemon") {
            throw new Error("Only a daemon socket can replace a daemon");
        }
        this.#socket.serializeAttachment({ ...identity, role: "replaced-daemon" });
        this.#socket.close(1012, "Daemon connection replaced");
    };

    private readonly hostAttachment = () => {
        const attachment = v.parse(attachmentSchema, this.#socket.deserializeAttachment());
        if (attachment.role !== "host") {
            throw new Error("A Computer socket cannot carry a Host control request");
        }
        return attachment;
    };
}

export class CloudflareRelayPeers implements ComputerPeers {
    readonly #state: DurableObjectState;

    constructor(state: DurableObjectState) {
        this.#state = state;
    }

    readonly sockets = () =>
        this.#state.getWebSockets().map((webSocket) => {
            const socket = new CloudflareRelaySocket(webSocket);
            return { socket, identity: socket.identity() };
        });

    readonly daemonConnections: ComputerPeers["daemonConnections"] = () =>
        this.#state.getWebSockets("daemon").map((webSocket) => {
            const socket = new CloudflareRelaySocket(webSocket);
            const answeredAt = this.#state.getWebSocketAutoResponseTimestamp(webSocket)?.getTime();
            const heartbeat: DaemonHeartbeat =
                answeredAt === undefined ? { kind: "none" } : { kind: "received", at: answeredAt };
            return { heartbeat, identity: socket.identity(), socket };
        });

    readonly daemons = (): readonly RelaySocket[] =>
        this.sockets()
            .filter(({ identity }) => identity.role === "daemon")
            .map(({ socket }) => socket);

    readonly hosts = (): readonly RelaySocket[] =>
        this.#state.getWebSockets("host").map((socket) => new CloudflareRelaySocket(socket));

    readonly viewers = () =>
        this.sockets().flatMap(({ socket, identity }) =>
            identity.role === "viewer"
                ? [
                      {
                          socket,
                          target: identity.sessionFilter,
                          expiresAt: identity.expiresAt,
                      },
                  ]
                : [],
        );

    readonly operations: ComputerPeers["operations"] = () => [];

    readonly nativeRequests = (): readonly { readonly requestId: string; readonly socket: RelaySocket }[] =>
        this.#state.getWebSockets("native-request").map((webSocket) => {
            const socket = new CloudflareRelaySocket(webSocket);
            const identity = socket.identity();
            if (identity.role !== "host" || identity.nativeRequestId === undefined) {
                throw new Error("A native request connection requires a reply address");
            }
            return { requestId: identity.nativeRequestId, socket };
        });

    readonly historyRecipients = (): readonly RelaySocket[] =>
        this.sockets()
            .filter(({ socket }) => socket.permitsSessionHistory())
            .map(({ socket }) => socket);

    readonly accept: ComputerPeers["accept"] = (identity) => {
        const pair = new WebSocketPair();
        const server = pair[1];
        server.serializeAttachment(attachment(identity));
        this.#state.acceptWebSocket(server, [
            identity.role === "host" && identity.nativeRequestId !== undefined ? "native-request" : identity.role,
        ]);
        return {
            socket: new CloudflareRelaySocket(server),
            response: new Response(null, { status: 101, webSocket: pair[0] }),
        };
    };
}

function attachment(identity: ComputerSocketIdentity): v.InferInput<typeof attachmentSchema> {
    return identity.role === "host" ? { ...identity, pendingAgentSettingsDiscoveries: [] } : identity;
}
