import { nativeSessionKey } from "@morty-build/client/native-session";
import {
    COMPUTER_LIVENESS_READY_KIND,
    COMPUTER_STATUS_KIND,
    type ComputerLivenessReadyEvent,
    type DaemonToRelayMessage,
    decodeDaemonToRelayMessage,
    decodeKnownServiceToDaemonMessage,
    encodeComputerStatusEvent,
    encodeServiceToDaemonMessage,
    type NativeSessionTarget,
    SESSION_EVENT_KIND,
    type SessionAccessHolder,
} from "@morty-build/client/protocol";
import { ProjectPermission } from "../../entity/authentication/project-authentication.ts";
import type { ComputerConnectionIdentity } from "../../entity/channel/computer-connection.ts";
import { ComputerScope } from "../../entity/do/session.ts";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import { logger } from "../../infra/logger.ts";
import { computerCommandPermission } from "../pairing/computer-control-registry.ts";
import type { ChannelActor, ChannelPeers, ChannelSocket } from "./channel-actor.ts";
import type { ChannelCredentialService } from "./channel-credential-service.ts";
import type { ComputerConnectionService } from "./computer-connection-service.ts";
import { ComputerMessageScheduler, ComputerMessageSchedulerCapacityError } from "./computer-message-scheduler.ts";

const DAEMON_ATTACHMENT_TIMEOUT_MILLISECONDS = 30_000;

const DAEMON_DETACH_TIMEOUT_MILLISECONDS = 30_000;

// A live daemon heartbeats every 20 seconds and abandons a connection whose acknowledgement takes
// longer than 10 seconds. A daemon silent past both, plus delivery slack, has lost this connection
// even though the Relay never saw it close, so commands sent into it would never be answered.
const DAEMON_HEARTBEAT_SILENCE_LIMIT_MILLISECONDS = 35_000;

/** Whether a heartbeat on a daemon connection has been answered, and when it last was. */
export type DaemonHeartbeat = { readonly kind: "none" } | { readonly kind: "received"; readonly at: number };

export type ComputerSocketIdentity =
    | {
          readonly role: "viewer";
          readonly expiresAt: number;
          /** The verified Session credential's authority, signing generation and whose access it carries. */
          readonly credential: {
              readonly signingKeyId: string;
              readonly holder: SessionAccessHolder;
          };
          readonly computerId: string;

          readonly sessionFilter: NativeSessionTarget;
      }
    | {
          readonly role: "relay";
          readonly computerId: string;
      }
    | {
          readonly role: "host";
          readonly nativeRequestId?: string;
          readonly sessionFilter?: NativeSessionTarget;

          readonly computerId: string;
      }
    | {
          readonly role: "daemon" | "replaced-daemon";
          readonly connectionEpoch: number;
          readonly computerId: string;
      };

export interface ComputerSocket extends ChannelSocket {
    readonly replaceDaemon: () => void;
}

export interface ComputerPeers extends ChannelPeers {
    readonly sockets: () => readonly { readonly identity: ComputerSocketIdentity; readonly socket: ComputerSocket }[];
    /** Daemon connections with the time each one's heartbeat was last answered by the host. */
    readonly daemonConnections: () => readonly {
        readonly identity: ComputerSocketIdentity;
        readonly socket: ComputerSocket;
        readonly heartbeat: DaemonHeartbeat;
    }[];
    readonly accept: (identity: ComputerSocketIdentity) => {
        readonly socket: ComputerSocket;
        readonly response: Response;
    };
}

type ComputerPeer = ReturnType<ComputerPeers["sockets"]>[number];

interface ComputerContext {
    readonly services: {
        readonly connections: ComputerConnectionService;
        readonly credentials: {
            readonly activeGeneration: ChannelCredentialService["activeGeneration"];
            /**
             * Whether the credential that opened a host connection still authorizes it ("revoked" when not) and
             * grants the permission one message needs ("denied" when not).
             */
            readonly authorizeHostMessage: (
                identity: Extract<ComputerSocketIdentity, { readonly role: "host" }>,
                permission: ProjectPermission | null,
                signal: AbortSignal,
            ) => Promise<"granted" | "revoked" | "denied">;
            /** Whether the Session credential that opened a live Session view still authorizes reading it. */
            readonly authorizeViewer: (
                identity: Extract<ComputerSocketIdentity, { readonly role: "viewer" }>,
                signal: AbortSignal,
            ) => Promise<"granted" | "revoked">;
        };
        readonly channel: (scope: ComputerScope) => ChannelActor;
    };
    readonly gateways: {
        readonly peers: ComputerPeers;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}

export type ComputerCredentials = ComputerContext["services"]["credentials"];

export type ComputerAdmission =
    | { readonly kind: "revoked" }
    | { readonly kind: "accepted"; readonly response: Response };

type DaemonSocketIdentity = Extract<ComputerSocketIdentity, { readonly role: "daemon" | "replaced-daemon" }> & {
    readonly role: "daemon";
};

export class ComputerService {
    readonly #cx: ComputerContext;
    readonly #channels = new Map<string, ChannelActor>();
    readonly #daemonMessages = new ComputerMessageScheduler();
    readonly #attachments = new Set<{
        readonly controller: AbortController;
        readonly identity: DaemonSocketIdentity;
    }>();
    #acceptTail: Promise<void> = Promise.resolve();
    readonly #accepting = new Set<{
        readonly computerId: string;
        readonly scope: ComputerScope;
        readonly controller: AbortController;
    }>();

    constructor(cx: ComputerContext) {
        this.#cx = cx;
    }

    readonly acceptDaemon = (scope: ComputerScope, signal: AbortSignal) =>
        this.admit(scope, signal, (admission, generation) => {
            const operation = this.#acceptTail.then(() => this.acceptDaemonSocket(scope, admission, generation));
            this.#acceptTail = operation.then(
                () => undefined,
                () => undefined,
            );
            return operation;
        });

    /**
     * Admits a connection only while a generation of this Computer is active, under that generation. The pending
     * admission is registered before that authority is read: a revocation committed after the read is notified
     * after it, and the notification aborts the admission. `accept` must check the admission signal and then
     * accept without awaiting, so a later notification finds the accepted socket and closes it.
     */
    private readonly admit = async <T>(
        scope: ComputerScope,
        signal: AbortSignal,
        accept: (admission: AbortSignal, generation: number) => Promise<T>,
    ): Promise<T | { readonly kind: "revoked" }> => {
        const pending = { computerId: scope.computerId, scope, controller: new AbortController() };
        this.#accepting.add(pending);
        try {
            const admission = AbortSignal.any([signal, pending.controller.signal]);
            const computer = { computerId: scope.computerId };
            const generation = await this.#cx.services.credentials.activeGeneration(computer, admission);
            if (generation === null) {
                return { kind: "revoked" };
            }
            return await accept(admission, generation);
        } catch (error) {
            signal.throwIfAborted();
            if (pending.controller.signal.aborted) {
                return { kind: "revoked" };
            }
            throw error;
        } finally {
            this.#accepting.delete(pending);
        }
    };

    private readonly acceptDaemonSocket = (
        scope: ComputerScope,
        signal: AbortSignal,
        generation: number,
    ): ComputerAdmission => {
        // Nothing below awaits, so this admission check and accept + connect are one step.
        signal.throwIfAborted();
        const latest = this.#cx.services.connections.latest();
        // The connections opened during an earlier generation belong to the Computer that generation paired.
        if (latest !== null && latest.generation !== generation) {
            for (const { socket } of this.#cx.gateways.peers.sockets()) {
                socket.close(1000, "Previous daemon disconnected");
            }
            for (const { socket } of this.#cx.gateways.peers.operations()) {
                socket.close(1000, "Previous daemon disconnected");
            }
        }
        const previous = this.#cx.gateways.peers
            .sockets()
            .filter(({ identity, socket }) => identity.role === "daemon" && socket.isOpen());
        for (const attachment of this.#attachments) {
            if (attachment.identity.computerId === scope.computerId) {
                attachment.controller.abort(new DOMException("Computer connection replaced", "AbortError"));
            }
        }
        for (const { socket } of previous) {
            socket.replaceDaemon();
        }
        const connection = this.#cx.services.connections.next(scope.computerId);
        const identity: DaemonSocketIdentity = { ...connection, role: "daemon" };
        const accepted = this.#cx.gateways.peers.accept(identity);
        this.#cx.services.connections.connected(connection, generation, Date.now());
        logger.info({ ...identity, event: "computer_websocket_accepted" }, "Computer WebSocket accepted");
        this.deferDaemonAttachment(identity, accepted.socket, scope, previous.length > 0);
        return { kind: "accepted", response: accepted.response };
    };

    private readonly deferDaemonAttachment = (
        identity: DaemonSocketIdentity,
        socket: ComputerSocket,
        scope: ComputerScope,
        replaced: boolean,
    ): void => {
        const attachment = { controller: new AbortController(), identity };
        this.#attachments.add(attachment);
        // An uncancellable AbortSignal.timeout would keep this Durable Object awake for the whole deadline
        // after the attachment finished, so the timer is cleared once it settles.
        const timeout = new AbortController();
        const timer = setTimeout(
            () => timeout.abort(new DOMException("The Computer attachment timed out", "TimeoutError")),
            DAEMON_ATTACHMENT_TIMEOUT_MILLISECONDS,
        );
        const signal = AbortSignal.any([attachment.controller.signal, timeout.signal]);
        const operation = (async () => {
            try {
                await this.attachDaemon(scope, replaced, signal);
                signal.throwIfAborted();
                if (!this.#cx.services.connections.isCurrent(identity)) {
                    return;
                }
                const ready: ComputerLivenessReadyEvent = { kind: COMPUTER_LIVENESS_READY_KIND };
                socket.send(encodeServiceToDaemonMessage(ready));
            } catch (error) {
                if (!attachment.controller.signal.aborted) {
                    logger.error(
                        { ...identity, err: error, event: "computer_attachment_failed" },
                        "Computer attachment failed",
                    );
                }
                if (this.#cx.services.connections.isCurrent(identity)) {
                    socket.close(1011, "Computer attachment failed");
                }
            } finally {
                clearTimeout(timer);
                this.#attachments.delete(attachment);
            }
        })();
        this.#cx.utilities.waitUntil(operation);
    };

    readonly acceptHost = (
        identity: Extract<ComputerSocketIdentity, { readonly role: "host" | "relay" }>,
        signal: AbortSignal,
    ): Promise<ComputerAdmission> => {
        const scope = new ComputerScope(identity.computerId);
        return this.admit(scope, signal, async (admission): Promise<ComputerAdmission> => {
            admission.throwIfAborted();
            const accepted = this.#cx.gateways.peers.accept(identity);
            await this.attachHost(scope, accepted.socket, signal);
            return { kind: "accepted", response: accepted.response };
        });
    };

    readonly revokeComputer = async (scope: ComputerScope, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        // The Project's Computer authority committed the revocation before notifying; acceptance and every
        // daemon message read that authority, so this notification only cleans up promptly. Its one fallible
        // step runs first, so a failed notification leaves this Relay unchanged for the caller to retry.
        // A delayed disconnect must not close the daemon that claimed a fresh authorization.
        if ((await this.#cx.services.credentials.activeGeneration({ computerId: scope.computerId }, signal)) !== null) {
            return;
        }
        const latest = this.#cx.services.connections.latest();
        const connected = latest?.kind === "connected" && latest.computerId === scope.computerId;
        if (connected) {
            this.#cx.services.connections.disconnected(latest, Date.now());
        }
        for (const accepting of this.#accepting) {
            if (accepting.computerId === scope.computerId && accepting.scope.computerId === scope.computerId) {
                accepting.controller.abort(new DOMException("Computer revoked", "AbortError"));
            }
        }
        for (const attachment of this.#attachments) {
            if (attachment.identity.computerId === scope.computerId) {
                attachment.controller.abort(new DOMException("Computer revoked", "AbortError"));
            }
        }
        for (const { identity, socket } of this.#cx.gateways.peers.sockets()) {
            if (identity.computerId !== scope.computerId) {
                continue;
            }
            if (identity.role === "daemon") {
                socket.close(1008, "Computer revoked");
            } else if (
                identity.role === "viewer" ||
                (identity.role === "host" && identity.computerId === scope.computerId)
            ) {
                socket.close(1008, "Computer revoked");
            }
        }
        if (connected) {
            this.notifyOffline(scope.computerId);
        }
    };

    /**
     * Closes the host connections and live Session views whose credential no longer authorizes them. A host's own
     * messages are authorized as they arrive, but nothing the Computer sends to a quiet host or to a view is, so the
     * Relay runs this as soon as access to the computer ends, and periodically while either is connected.
     */
    readonly reauthorizeConnections = async (signal: AbortSignal): Promise<void> => {
        for (const { identity, socket } of this.#cx.gateways.peers.sockets()) {
            if (
                identity.role === "host" &&
                (await this.#cx.services.credentials.authorizeHostMessage(identity, null, signal)) === "revoked"
            ) {
                socket.close(1008, "Channel access revoked");
            }
            if (
                identity.role === "viewer" &&
                (await this.#cx.services.credentials.authorizeViewer(identity, signal)) === "revoked"
            ) {
                socket.close(1008, "Session access revoked");
            }
        }
    };

    /** Closes daemon connections that stopped heartbeating or were superseded, so presence reads report them offline. */
    readonly expireSilentDaemons = async (): Promise<void> => {
        await this.detachDaemons(this.closeSilentDaemons());
    };

    readonly isOnline = (computerId: string): boolean => {
        const current = this.#cx.services.connections.current();
        return current !== null && current.computerId === computerId && this.#cx.gateways.peers.daemons().length > 0;
    };

    readonly attachDaemon = async (scope: ComputerScope, replaced: boolean, signal: AbortSignal): Promise<void> => {
        const channel = this.channel(scope);
        await channel.attachDaemon(replaced, signal);
    };

    readonly attachHost = (scope: ComputerScope, socket: ChannelSocket, signal: AbortSignal) =>
        this.channel(scope).attachHost(socket, signal);

    /** The public HTTP handler already authorized this operation; no host credential is involved. */
    readonly receiveOperation = async (
        scope: ComputerScope,
        socket: ChannelSocket,
        message: unknown,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const silent = this.closeSilentDaemons();
        try {
            const daemon = this.#cx.gateways.peers
                .sockets()
                .find(
                    ({ identity, socket: peer }) =>
                        identity.role === "daemon" &&
                        peer.isOpen() &&
                        this.#cx.services.connections.isCurrent(identity),
                );
            if (daemon !== undefined && daemon.identity.computerId !== scope.computerId) {
                throw new PairingDirectoryError("computer_access_denied", "The selected Computer is unavailable");
            }
            const channel = this.channel(scope);
            if (typeof message === "string") {
                await channel.receiveHostMessage(socket, message, signal);
            } else {
                channel.receiveHostChunk(socket, message);
            }
        } finally {
            await this.detachDaemons(silent);
        }
    };

    readonly receiveMessage = async (
        identity: ComputerSocketIdentity,
        socket: ComputerSocket,
        message: unknown,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const scope = new ComputerScope(identity.computerId);
        if (identity.role === "host" || identity.role === "relay" || identity.role === "viewer") {
            // Closing first makes this command see the Computer as offline and fail at once; detaching
            // afterwards releases commands already sent into the silent connection.
            const silentDaemons = this.closeSilentDaemons();
            try {
                if (identity.role === "relay") {
                    const channel = this.channel(scope);
                    if (typeof message !== "string") {
                        channel.receiveHostChunk(socket, message);
                        return;
                    }
                    await channel.receiveHostMessage(socket, message, signal);
                    return;
                }
                if (identity.role === "viewer") {
                    socket.close(1008, "A live subscription cannot send commands");
                    return;
                }
                // Content bytes continue an upload, which needs Session write access like the content.write that
                // started it. An unknown message needs only the connection's own access; the channel skips it.
                const command = typeof message === "string" ? decodeKnownServiceToDaemonMessage(message) : null;
                const permission =
                    typeof message === "string"
                        ? command === null
                            ? null
                            : computerCommandPermission(command)
                        : ProjectPermission.SessionWrite;
                switch (await this.#cx.services.credentials.authorizeHostMessage(identity, permission, signal)) {
                    case "revoked":
                        socket.close(1008, "Channel access revoked");
                        return;
                    case "denied":
                        socket.close(1008, "project_permission_denied");
                        return;
                    case "granted":
                        break;
                }
                const channel = this.channel(scope);
                if (typeof message !== "string") {
                    channel.receiveHostChunk(socket, message);
                    return;
                }
                await channel.receiveHostMessage(socket, message, signal);
                return;
            } finally {
                await this.detachDaemons(silentDaemons);
            }
        }
        if (typeof message !== "string") {
            try {
                await this.#daemonMessages.run(["computer"], signal, async () => {
                    signal.throwIfAborted();
                    if (!(await this.authorizeDaemonMessage(identity, socket, signal))) {
                        return;
                    }
                    this.channel(scope).receiveDaemonChunk(socket, message);
                });
            } catch (error) {
                signal.throwIfAborted();
                socket.close(
                    error instanceof ComputerMessageSchedulerCapacityError ? 1013 : 1008,
                    "Invalid content chunk",
                );
            }
            return;
        }
        if (message.length > 8 * 1024 * 1024) {
            socket.close(1003, "Bounded text message required");
            return;
        }
        let daemonMessage: DaemonToRelayMessage | null;
        try {
            daemonMessage = decodeDaemonToRelayMessage(message);
        } catch {
            // Reject this frame without disconnecting unrelated Sessions.
            this.channel(scope).recordSkipped("invalid_daemon_message");
            return;
        }
        const lanes = daemonMessage === null ? ["computer"] : this.daemonMessageLanes(daemonMessage);
        try {
            await this.#daemonMessages.run(lanes, signal, async () => {
                signal.throwIfAborted();
                if (!(await this.authorizeDaemonMessage(identity, socket, signal))) {
                    return;
                }
                const channel = this.channel(scope);
                await channel.receiveDaemonMessage(socket, daemonMessage, signal, message);
            });
        } catch (error) {
            if (error instanceof ComputerMessageSchedulerCapacityError) {
                logger.warn(
                    { ...identity, err: error, event: "computer_message_queue_full", closeCode: 1013 },
                    "Computer message queue full",
                );
                socket.close(1013, error.code);
                return;
            }
            throw error;
        }
    };

    private readonly authorizeDaemonMessage = async (
        identity: Extract<ComputerSocketIdentity, { readonly role: "daemon" | "replaced-daemon" }>,
        socket: ComputerSocket,
        signal: AbortSignal,
    ): Promise<boolean> => {
        if (identity.role === "replaced-daemon") {
            socket.close(1012, "Daemon connection replaced");
            return false;
        }
        if (this.fenceDaemon(identity, socket)) {
            return false;
        }
        // Disconnect delivery can fail after revocation commits in Project storage, and the Project can stop being
        // served. Read that authority before every business message; the local connection fence alone is insufficient.
        try {
            if ((await this.#cx.services.credentials.activeGeneration(identity, signal)) === null) {
                socket.close(1008, "Computer revoked");
                return false;
            }
        } catch (error) {
            signal.throwIfAborted();
            logger.warn(
                { ...identity, err: error, event: "computer_authorization_failed", closeCode: 1011 },
                "Computer authorization unavailable",
            );
            socket.close(1011, "Computer authorization unavailable");
            return false;
        }
        // A replacement may have been accepted while the authoritative lookup was in flight.
        if (this.fenceDaemon(identity, socket)) {
            return false;
        }
        return socket.isOpen();
    };

    /**
     * Closes a daemon connection that is no longer the current one, telling a replaced daemon to reconnect and the
     * daemon of an ended generation that its Computer was revoked. True when it closed the connection.
     */
    private readonly fenceDaemon = (identity: ComputerConnectionIdentity, socket: ComputerSocket): boolean => {
        const standing = this.#cx.services.connections.standing(identity);
        switch (standing) {
            case "current":
                return false;
            case "replaced":
                socket.replaceDaemon();
                return true;
            case "ended":
                socket.close(1008, "Computer revoked");
                return true;
            default:
                return standing satisfies never;
        }
    };

    /**
     * A Session's events are delivered in the order the daemon sent them. A batch that carries several
     * Sessions takes its place in each of their lanes, so a later batch for one of them cannot overtake it.
     */
    private readonly daemonMessageLanes = (message: DaemonToRelayMessage): readonly string[] => {
        if (message.kind === SESSION_EVENT_KIND) {
            const sessionKeys = new Set(message.events.map((event) => nativeSessionKey(event.target)));
            return sessionKeys.size === 0 ? ["session:unknown"] : [...sessionKeys].map((key) => `session:${key}`);
        }
        return ["computer"];
    };

    private readonly channel = (scope: ComputerScope): ChannelActor => {
        const key = JSON.stringify({
            computerId: scope.computerId,
        });
        const existing = this.#channels.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const channel = this.#cx.services.channel(scope);
        this.#channels.set(key, channel);
        return channel;
    };

    readonly detach = async (
        identity: ComputerSocketIdentity,
        socket: ChannelSocket,
        signal: AbortSignal,
    ): Promise<void> => {
        // The latest connection detaches once it closes, also after its generation ended: what was sent into it
        // must still be released.
        const latest = () =>
            identity.role === "daemon" && this.#cx.services.connections.standing(identity) !== "replaced";
        if (identity.role !== "daemon" || !latest()) {
            return;
        }
        for (const attachment of this.#attachments) {
            if (
                attachment.identity.computerId === identity.computerId &&
                attachment.identity.connectionEpoch === identity.connectionEpoch
            ) {
                attachment.controller.abort(new DOMException("Computer connection closed", "AbortError"));
            }
        }
        await this.#daemonMessages.idle(signal);
        if (!latest()) {
            return;
        }
        this.#cx.services.connections.disconnected(identity, Date.now());
        await this.channel(new ComputerScope(identity.computerId)).detachDaemon(socket, signal);
    };

    private readonly closeSilentDaemons = (): readonly ComputerPeer[] => {
        const now = Date.now();
        const silent: ComputerPeer[] = [];
        for (const { identity, socket, heartbeat } of this.#cx.gateways.peers.daemonConnections()) {
            if (identity.role !== "daemon" || !socket.isOpen()) {
                continue;
            }
            // The host answers heartbeats without running the Relay, so a superseded connection that
            // keeps heartbeating is retired here instead of when it heartbeats.
            if (this.fenceDaemon(identity, socket)) {
                continue;
            }
            const heardAt = heartbeat.kind === "received" ? heartbeat.at : this.firstHeartbeatDue();
            if (heardAt === null || now - heardAt <= DAEMON_HEARTBEAT_SILENCE_LIMIT_MILLISECONDS) {
                continue;
            }
            logger.warn(
                {
                    ...identity,
                    closeCode: 4001,
                    event: "computer_heartbeat_silence",
                    silenceMilliseconds: now - heardAt,
                },
                "Computer daemon stopped heartbeating",
            );
            socket.close(4001, "Computer heartbeat timed out");
            silent.push({ identity, socket });
        }
        return silent;
    };

    /**
     * A daemon sends its first heartbeat once its attachment is ready, which the attachment deadline
     * bounds, so a connection still silent past that deadline counts as silent from it.
     */
    private readonly firstHeartbeatDue = (): number | null => {
        const current = this.#cx.services.connections.current();
        return current === null ? null : current.connectedAt + DAEMON_ATTACHMENT_TIMEOUT_MILLISECONDS;
    };

    // The connection may never report its close, so the Relay detaches it itself. The command or
    // read that noticed the silence may end first, so the detach does not share its cancellation.
    private readonly detachDaemons = async (daemons: readonly ComputerPeer[]): Promise<void> => {
        for (const { identity, socket } of daemons) {
            const timeout = new AbortController();
            const timer = setTimeout(
                () => timeout.abort(new DOMException("The Computer detach timed out", "TimeoutError")),
                DAEMON_DETACH_TIMEOUT_MILLISECONDS,
            );
            try {
                await this.detach(identity, socket, timeout.signal);
            } finally {
                clearTimeout(timer);
            }
        }
    };

    private readonly notifyOffline = (computerId: string): void => {
        for (const host of [
            ...this.#cx.gateways.peers.hosts(),
            ...this.#cx.gateways.peers.operations().map(({ socket }) => socket),
            ...this.#cx.gateways.peers.nativeRequests().map(({ socket }) => socket),
        ]) {
            if (host.isOpen()) {
                host.send(encodeComputerStatusEvent({ kind: COMPUTER_STATUS_KIND, computerId, online: false }));
            }
        }
    };
}
