import * as v from "valibot";

const commandIdSchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
const activeTurnSchema = v.pipe(
    v.variant("kind", [
        v.object({ commandId: commandIdSchema, kind: v.literal("submitting") }),
        v.object({ commandId: commandIdSchema, kind: v.literal("accepted"), turnId: commandIdSchema }),
    ]),
    v.readonly(),
);

export type SessionActiveTurn = { readonly kind: "idle" } | v.InferOutput<typeof activeTurnSchema>;

type SessionActiveTurnEvent =
    | { readonly kind: "submission-started"; readonly commandId: string }
    | { readonly kind: "submission-accepted"; readonly commandId: string; readonly turnId: string }
    | { readonly kind: "turn-cleared"; readonly commandId: string };

function transitionSessionActiveTurn(state: SessionActiveTurn, event: SessionActiveTurnEvent): SessionActiveTurn {
    switch (event.kind) {
        case "submission-started":
            return { commandId: event.commandId, kind: "submitting" };
        case "submission-accepted":
            return { commandId: event.commandId, kind: "accepted", turnId: event.turnId };
        case "turn-cleared":
            return state.kind !== "idle" && state.commandId === event.commandId ? { kind: "idle" } : state;
    }
}

function readPersistedTurn(storage: Storage, key: string): SessionActiveTurn {
    const encoded = storage.getItem(key);
    if (encoded === null) {
        return { kind: "idle" };
    }
    try {
        const parsed = v.safeParse(activeTurnSchema, JSON.parse(encoded));
        return parsed.success ? parsed.output : { kind: "idle" };
    } catch {
        return { kind: "idle" };
    }
}

export function createSessionActiveTurn(options: {
    readonly sessionId: string;
    readonly initial: SessionActiveTurn;
    readonly storage: Storage;
}) {
    const storageKey = `mobius.session-active-turn.v1:${options.sessionId}`;
    let state = options.initial.kind === "idle" ? readPersistedTurn(options.storage, storageKey) : options.initial;

    const persist = (): void => {
        if (state.kind === "idle") {
            options.storage.removeItem(storageKey);
        } else {
            options.storage.setItem(storageKey, JSON.stringify(state));
        }
    };
    persist();

    const transition = (event: SessionActiveTurnEvent): void => {
        state = transitionSessionActiveTurn(state, event);
        persist();
    };

    return {
        current: (): SessionActiveTurn => state,
        submissionAccepted: (commandId: string, turnId: string): void =>
            transition({ commandId, kind: "submission-accepted", turnId }),
        submissionStarted: (commandId: string): void => transition({ commandId, kind: "submission-started" }),
        turnCleared: (commandId: string): void => transition({ commandId, kind: "turn-cleared" }),
    } as const;
}
