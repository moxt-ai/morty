import { NativeSessionMap } from "@morty-build/client/native-session";
import type { SessionWireEnvelope } from "@morty-build/client/protocol";
import type { RelayPeers } from "./computer-relay-actor.ts";

export class SessionLiveEventRelay {
    readonly #peers: RelayPeers;

    constructor(peers: RelayPeers) {
        this.#peers = peers;
    }

    readonly receive = (envelope: SessionWireEnvelope): void => {
        const eventsBySession = new NativeSessionMap<(typeof envelope.events)[number][]>();
        for (const event of envelope.events) {
            const events = eventsBySession.get(event.target) ?? [];
            events.push(event);
            eventsBySession.set(event.target, events);
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
    };
}
