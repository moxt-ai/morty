import { MemorySessionEventStore, type SessionEventStore } from "../../session/history/session-event-store.ts";
import { AcpExecutionError } from "../acp-error.ts";
import type { NativeSessionPreviewKey } from "../adapter/query-scope.ts";

/** Snapshot lifetime is independent of the client that produced its events. */
export interface HistoryPreviewSnapshot {
    readonly events: SessionEventStore;
    readonly close: () => void;
}

export function memoryHistoryPreviewSnapshot(): HistoryPreviewSnapshot {
    const events = new MemorySessionEventStore();
    return { events, close: events.close };
}

export class NativeHistoryPreviewSnapshots {
    readonly #snapshots = new Map<NativeSessionPreviewKey, HistoryPreviewSnapshot>();
    readonly #create: () => HistoryPreviewSnapshot;

    constructor(create: () => HistoryPreviewSnapshot) {
        this.#create = create;
    }

    readonly replace = (key: NativeSessionPreviewKey): SessionEventStore => {
        this.#snapshots.get(key)?.close();
        const store = this.#create();
        this.#snapshots.set(key, store);
        return store.events;
    };

    readonly get = (key: NativeSessionPreviewKey): SessionEventStore => {
        const store = this.#snapshots.get(key);
        if (store === undefined) {
            throw new AcpExecutionError("The native event cursor is invalid", {}, "invalid_native_session_response");
        }
        return store.events;
    };

    readonly discard = (key: NativeSessionPreviewKey, store: SessionEventStore): void => {
        const snapshot = this.#snapshots.get(key);
        if (snapshot?.events === store) {
            this.#snapshots.delete(key);
            snapshot.close();
        }
    };

    readonly close = (): void => {
        for (const store of this.#snapshots.values()) {
            store.close();
        }
        this.#snapshots.clear();
    };
}
