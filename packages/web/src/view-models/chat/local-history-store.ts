import type { NativeHistoryMessage } from "@moxt-ai/mobius-protocol";
import { createStore } from "zustand/vanilla";

const RECENT_MESSAGE_COUNT = 40;

interface HistoryData {
    readonly messages: readonly NativeHistoryMessage[];
    readonly truncated: boolean;
    readonly visibleCount: number;
}

export type LocalHistoryState =
    | { readonly kind: "none" }
    | { readonly kind: "loading"; readonly sessionId: string }
    | { readonly kind: "refreshing"; readonly sessionId: string; readonly data: HistoryData }
    | { readonly kind: "ready"; readonly sessionId: string; readonly data: HistoryData }
    | {
          readonly kind: "failed";
          readonly sessionId: string;
          readonly data: HistoryData | null;
          readonly message: string;
      };

export interface LocalHistoryStore {
    readonly state: LocalHistoryState;
    readonly select: (sessionId: string | null) => void;
    readonly begin: (sessionId: string) => number | null;
    readonly complete: (
        sessionId: string,
        revision: number,
        result: { readonly messages: readonly NativeHistoryMessage[]; readonly truncated: boolean },
    ) => void;
    readonly fail: (sessionId: string, revision: number, message: string) => void;
    readonly loadMore: () => void;
}

function priorData(state: LocalHistoryState, sessionId: string): HistoryData | null {
    if (state.kind === "ready" || state.kind === "refreshing" || state.kind === "failed") {
        return state.sessionId === sessionId ? state.data : null;
    }
    return null;
}

export const createLocalHistoryStore = () => {
    let revision = 0;
    return createStore<LocalHistoryStore>()((set, get) => ({
        state: { kind: "none" },
        select: (sessionId) => {
            revision += 1;
            set({ state: sessionId === null ? { kind: "none" } : { kind: "loading", sessionId } });
        },
        begin: (sessionId) => {
            const current = get().state;
            if (current.kind === "none" || current.sessionId !== sessionId) {
                return null;
            }
            revision += 1;
            const data = priorData(current, sessionId);
            set({ state: data === null ? { kind: "loading", sessionId } : { kind: "refreshing", sessionId, data } });
            return revision;
        },
        complete: (sessionId, requestedRevision, result) => {
            const current = get().state;
            if (revision !== requestedRevision || current.kind === "none" || current.sessionId !== sessionId) {
                return;
            }
            const prior = priorData(current, sessionId);
            set({
                state: {
                    kind: "ready",
                    sessionId,
                    data: {
                        messages: result.messages,
                        truncated: result.truncated,
                        visibleCount: Math.min(result.messages.length, prior?.visibleCount ?? RECENT_MESSAGE_COUNT),
                    },
                },
            });
        },
        fail: (sessionId, requestedRevision, message) => {
            const current = get().state;
            if (revision !== requestedRevision || current.kind === "none" || current.sessionId !== sessionId) {
                return;
            }
            set({ state: { kind: "failed", sessionId, data: priorData(current, sessionId), message } });
        },
        loadMore: () => {
            const current = get().state;
            if (current.kind !== "ready") {
                return;
            }
            const data = current.data;
            set({
                state: {
                    ...current,
                    data: {
                        ...data,
                        visibleCount: Math.min(data.messages.length, data.visibleCount + RECENT_MESSAGE_COUNT),
                    },
                },
            });
        },
    }));
};
