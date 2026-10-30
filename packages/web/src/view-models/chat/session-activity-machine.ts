/** What a Session reports about its work: its current turn, the last turn's failure, or nothing. */
export type SessionActivityState =
    | { readonly kind: "idle" }
    | { readonly kind: "working"; readonly commandId: string; readonly startedAt: number }
    | { readonly kind: "failed"; readonly commandId: string; readonly code: string; readonly message: string };

export function workingCommandId(state: SessionActivityState): string | null {
    switch (state.kind) {
        case "idle":
        case "failed":
            return null;
        case "working":
            return state.commandId;
    }
}
