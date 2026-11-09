import { NativeSessionMap } from "@morty-build/client/native-session";
import { encodeSessionWireEnvelope, type SessionWireEnvelope } from "@morty-build/client/protocol";
import type { SessionStatusNotifications } from "../../infra/session-status-notifications.ts";
import type { ChannelPeers } from "./channel-actor.ts";

export class SessionLiveEventRelay {
    readonly #computerId: string;
    readonly #peers: ChannelPeers;
    readonly #notifications: SessionStatusNotifications | undefined;

    constructor(computerId: string, peers: ChannelPeers, notifications?: SessionStatusNotifications) {
        this.#computerId = computerId;
        this.#peers = peers;
        this.#notifications = notifications;
    }

    readonly receive = (envelope: SessionWireEnvelope): void => {
        const eventsBySession = new NativeSessionMap<(typeof envelope.events)[number][]>();
        for (const event of envelope.events) {
            const events = eventsBySession.get(event.target) ?? [];
            events.push(event);
            eventsBySession.set(event.target, events);
        }
        let runtimeMessage: string | undefined;
        const sessionMessages = new NativeSessionMap<string>();
        for (const host of this.#peers.hosts()) {
            const sessionFilter = host.sessionFilter;
            let message: string;
            if (sessionFilter === undefined) {
                runtimeMessage ??= encodeSessionWireEnvelope(envelope);
                message = runtimeMessage;
            } else {
                const events = eventsBySession.get(sessionFilter);
                if (events === undefined) {
                    continue;
                }
                const encoded =
                    sessionMessages.get(sessionFilter) ?? encodeSessionWireEnvelope({ ...envelope, events });
                sessionMessages.set(sessionFilter, encoded);
                message = encoded;
            }
            try {
                host.send(message);
            } catch {
                host.close(1013, "Runtime channel backpressure");
            }
        }
        for (const viewer of this.#peers.viewers()) {
            if (viewer.expiresAt <= Date.now()) {
                viewer.socket.close(1000, "Session access expired");
                continue;
            }
            const events = eventsBySession.get(viewer.target);
            if (events === undefined) {
                continue;
            }
            try {
                viewer.socket.send(JSON.stringify(events));
            } catch {
                viewer.socket.close(1013, "Session subscription backpressure");
            }
        }
        // Status notifications observe live events, including when no browsers are watching. A restated outcome is not
        // a new fact, so it is never notified again.
        const events = envelope.events.filter((event) => event.mortyMetadata?.restated !== true);
        if (events.length > 0) {
            this.#notifications?.publish(
                { computerId: this.#computerId },
                events.length === envelope.events.length ? envelope : { ...envelope, events },
            );
        }
    };
}
