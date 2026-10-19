import { decodeIdentifier } from "@moxt-ai/mobius-sdk/protocol";

export type SessionActiveTurn =
    | { readonly kind: "idle" }
    | { readonly commandId: string; readonly kind: "submitting" }
    | { readonly commandId: string; readonly kind: "accepted"; readonly turnId: string };

type SessionActiveTurnEvent =
    | { readonly kind: "submission-started"; readonly commandId: string }
    | { readonly kind: "submission-accepted"; readonly commandId: string; readonly turnId: string }
    | { readonly kind: "turn-cleared"; readonly commandId: string };

function transitionSessionActiveTurn(state: SessionActiveTurn, event: SessionActiveTurnEvent): SessionActiveTurn {
    switch (event.kind) {
        case "submission-started":
            return { commandId: decodeIdentifier(event.commandId), kind: "submitting" };
        case "submission-accepted":
            return {
                commandId: decodeIdentifier(event.commandId),
                kind: "accepted",
                turnId: decodeIdentifier(event.turnId),
            };
        case "turn-cleared":
            return state.kind !== "idle" && state.commandId === event.commandId ? { kind: "idle" } : state;
    }
}

export function createSessionActiveTurn(options: { readonly initial: SessionActiveTurn }) {
    let state = options.initial;

    const transition = (event: SessionActiveTurnEvent): void => {
        state = transitionSessionActiveTurn(state, event);
    };

    return {
        current: (): SessionActiveTurn => state,
        submissionAccepted: (commandId: string, turnId: string): void =>
            transition({ commandId, kind: "submission-accepted", turnId }),
        submissionStarted: (commandId: string): void => transition({ commandId, kind: "submission-started" }),
        turnCleared: (commandId: string): void => transition({ commandId, kind: "turn-cleared" }),
    } as const;
}
