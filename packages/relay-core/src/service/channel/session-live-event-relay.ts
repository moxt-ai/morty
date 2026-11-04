import { encodeSessionWireEnvelope, type SessionWireEnvelope } from "@moxt-ai/mobius-sdk/protocol";
import type { SessionStatusNotifications } from "../../infra/session-status-notifications.ts";
import type { BestEffortRecording } from "./best-effort-recording.ts";
import type { ChannelPeers } from "./channel-actor.ts";

export class SessionLiveEventRelay {
    readonly #projectId: string;
    readonly #runtimeId: string;
    readonly #peers: ChannelPeers;
    readonly #recording: BestEffortRecording;
    readonly #notifications: SessionStatusNotifications | undefined;

    constructor(
        projectId: string,
        runtimeId: string,
        peers: ChannelPeers,
        recording: BestEffortRecording,
        notifications?: SessionStatusNotifications,
    ) {
        this.#projectId = projectId;
        this.#runtimeId = runtimeId;
        this.#peers = peers;
        this.#recording = recording;
        this.#notifications = notifications;
    }

    readonly receive = (envelope: SessionWireEnvelope): void => {
        const eventsBySession = new Map<string, (typeof envelope.events)[number][]>();
        for (const event of envelope.events) {
            const events = eventsBySession.get(event.sessionId) ?? [];
            events.push(event);
            eventsBySession.set(event.sessionId, events);
        }
        let runtimeMessage: string | undefined;
        const sessionMessages = new Map<string, string>();
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
            const events = eventsBySession.get(viewer.sessionId);
            if (events === undefined) {
                continue;
            }
            try {
                viewer.socket.send(JSON.stringify(events));
            } catch {
                viewer.socket.close(1013, "Session subscription backpressure");
            }
        }
        for (const route of this.#peers.operations()) {
            const events = envelope.events.filter((event) => {
                if (event.type !== "lifecycle-metadata" || event.sessionId !== route.sessionId) {
                    return false;
                }
                const payload = event.payload;
                if ("commandId" in payload) {
                    return payload.commandId === route.requestId;
                }
                if (payload.kind === "session.permission.resolved" || payload.kind === "session.elicitation.resolved") {
                    const interaction = payload["event"];
                    return (
                        typeof interaction === "object" &&
                        interaction !== null &&
                        "interactionId" in interaction &&
                        interaction.interactionId === route.requestId
                    );
                }
                return route.queueAcknowledgement && payload.kind === "session.queue.changed";
            });
            if (events.length > 0) {
                try {
                    route.socket.send(encodeSessionWireEnvelope({ ...envelope, events }));
                } catch {
                    route.socket.close(1013, "Runtime request backpressure");
                }
            }
        }
        // Both consumers observe live events, including when no browsers are watching. A restated outcome is not a new
        // fact, so it is never notified again. Recording alone knows whether it holds the outcome a restatement
        // repeats, and may have missed it, so it receives the restatements that repeat an outcome the Runtime recorded.
        const scope = { projectId: this.#projectId, runtimeId: this.#runtimeId };
        const select = (
            keep: (event: SessionWireEnvelope["events"][number]) => boolean,
        ): SessionWireEnvelope | null => {
            const events = envelope.events.filter(keep);
            return events.length === 0
                ? null
                : events.length === envelope.events.length
                  ? envelope
                  : { ...envelope, events };
        };
        const notified = select((event) => event.mobiusMetadata?.restated !== true);
        if (notified !== null) {
            this.#notifications?.publish(scope, notified);
        }
        const recorded = select(
            (event) => event.mobiusMetadata?.restated !== true || event.mobiusMetadata.recordedOutcome === true,
        );
        if (recorded !== null) {
            this.#recording.publish(scope, recorded);
        }
    };
}
