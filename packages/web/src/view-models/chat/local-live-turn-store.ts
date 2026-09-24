import {
    ACTIVE_TURN_TEXT_LIMIT,
    type AgentMessageDeltaEvent,
    type NativeSessionResult,
    type SessionStartedEvent,
} from "@moxt-ai/mobius-protocol";
import { createStore } from "zustand/vanilla";

type ActiveTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"];

type LiveStream =
    | { readonly kind: "unconfirmed" }
    | { readonly kind: "sequenced"; readonly epoch: string; readonly sequence: number };

type RunningTurn = {
    readonly kind: "running";
    readonly commandId: string;
    readonly sessionId: string;
    readonly prompt: string;
    readonly text: string;
    readonly truncated: boolean;
    readonly stream: LiveStream;
};

export type TurnState =
    | { readonly kind: "idle" }
    | RunningTurn
    | { readonly kind: "recovering"; readonly sessionId: string; readonly previous: RunningTurn | null }
    | {
          readonly kind: "recovery-failed";
          readonly sessionId: string;
          readonly previous: RunningTurn | null;
          readonly message: string;
      }
    | { readonly kind: "unknown"; readonly message: string; readonly prompt: string };

interface LiveTurnStore {
    readonly state: TurnState;
    readonly reset: () => void;
    readonly beginRecovery: (sessionId: string) => void;
    readonly failRecovery: (sessionId: string, message: string) => void;
    readonly start: (commandId: string, sessionId: string, prompt: string) => void;
    readonly receiveStarted: (message: SessionStartedEvent) => void;
    readonly receiveSnapshot: (sessionId: string, snapshot: ActiveTurnSnapshot) => void;
    readonly receiveDelta: (message: AgentMessageDeltaEvent) => "applied" | "duplicate" | "resync";
    readonly complete: (commandId: string) => void;
    readonly uncertain: (commandId: string, message: string) => void;
}

function appendText(
    current: Extract<TurnState, { readonly kind: "running" }>,
    delta: string,
): Pick<Extract<TurnState, { readonly kind: "running" }>, "text" | "truncated"> {
    const text = current.text + delta;
    return {
        text: text.slice(-ACTIVE_TURN_TEXT_LIMIT),
        truncated: current.truncated || text.length > ACTIVE_TURN_TEXT_LIMIT,
    };
}

export const createLocalLiveTurnStore = () =>
    createStore<LiveTurnStore>()((set, get) => ({
        state: { kind: "idle" },
        reset: () => set({ state: { kind: "idle" } }),
        beginRecovery: (sessionId) => {
            const current = get().state;
            const previous =
                current.kind === "running" && current.sessionId === sessionId
                    ? current
                    : (current.kind === "recovering" || current.kind === "recovery-failed") &&
                        current.sessionId === sessionId
                      ? current.previous
                      : null;
            set({ state: { kind: "recovering", sessionId, previous } });
        },
        failRecovery: (sessionId, message) => {
            const current = get().state;
            if (current.kind === "recovering" && current.sessionId === sessionId) {
                set({ state: { kind: "recovery-failed", sessionId, previous: current.previous, message } });
            }
        },
        start: (commandId, sessionId, prompt) =>
            set({
                state: {
                    kind: "running",
                    commandId,
                    sessionId,
                    prompt,
                    text: "",
                    truncated: false,
                    stream: { kind: "unconfirmed" },
                },
            }),
        receiveStarted: (message) => {
            const current = get().state;
            if (
                current.kind === "running" &&
                current.commandId === message.commandId &&
                current.stream.kind === "sequenced" &&
                current.stream.epoch === message.epoch
            ) {
                return;
            }
            set({
                state: {
                    kind: "running",
                    commandId: message.commandId,
                    sessionId: message.sessionId,
                    prompt: message.prompt,
                    text: "",
                    truncated: false,
                    stream: { kind: "sequenced", epoch: message.epoch, sequence: message.sequence },
                },
            });
        },
        receiveSnapshot: (sessionId, snapshot) => {
            const current = get().state;
            if (snapshot === null) {
                if (
                    (current.kind === "recovering" && current.sessionId === sessionId) ||
                    (current.kind === "running" && current.stream.kind === "sequenced")
                ) {
                    get().reset();
                }
                return;
            }
            const previous =
                current.kind === "recovering" ? current.previous : current.kind === "running" ? current : null;
            if (previous !== null) {
                if (previous.commandId !== snapshot.commandId && current.kind !== "recovering") {
                    return;
                }
                if (
                    previous.commandId === snapshot.commandId &&
                    previous.stream.kind === "sequenced" &&
                    previous.stream.epoch === snapshot.epoch &&
                    previous.stream.sequence >= snapshot.sequence
                ) {
                    if (current.kind === "recovering") {
                        set({ state: previous });
                    }
                    return;
                }
            }
            set({
                state: {
                    kind: "running",
                    commandId: snapshot.commandId,
                    sessionId,
                    prompt: snapshot.prompt,
                    text: snapshot.text,
                    truncated: snapshot.truncated,
                    stream: { kind: "sequenced", epoch: snapshot.epoch, sequence: snapshot.sequence },
                },
            });
        },
        receiveDelta: (message) => {
            const current = get().state;
            if (current.kind === "recovering" || current.kind === "recovery-failed") {
                return "duplicate";
            }
            if (current.kind !== "running" || current.commandId !== message.commandId) {
                return "resync";
            }
            if (current.stream.kind === "sequenced") {
                if (current.stream.epoch !== message.epoch) {
                    return "resync";
                }
                if (message.sequence <= current.stream.sequence) {
                    return "duplicate";
                }
                if (message.sequence !== current.stream.sequence + 1) {
                    return "resync";
                }
            } else if (message.sequence !== 1) {
                return "resync";
            }
            set({
                state: {
                    ...current,
                    ...appendText(current, message.text),
                    stream: { kind: "sequenced", epoch: message.epoch, sequence: message.sequence },
                },
            });
            return "applied";
        },
        complete: (commandId) => {
            const current = get().state;
            if (current.kind === "running" && current.commandId === commandId) {
                get().reset();
            }
        },
        uncertain: (commandId, message) => {
            const current = get().state;
            if (current.kind === "running" && current.commandId === commandId) {
                set({ state: { kind: "unknown", prompt: current.prompt, message } });
            }
        },
    }));
