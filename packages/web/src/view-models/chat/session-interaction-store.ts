import { createStore } from "zustand/vanilla";
import { formatError } from "../format-error.ts";
import type {
    ElicitationInteraction,
    ElicitationInteractionResponse,
    PermissionInteraction,
    PermissionInteractionResponse,
} from "./session-pane-types.ts";

type InteractionOperation =
    | { readonly kind: "idle" }
    | { readonly kind: "submitting"; readonly interactionId: string }
    | { readonly kind: "failed"; readonly interactionId: string; readonly message: string };

export interface SessionInteractionStore {
    readonly operation: InteractionOperation;
    readonly submitted: ReadonlySet<string>;
    readonly respondToPermission: (response: PermissionInteractionResponse, signal: AbortSignal) => void;
    readonly respondToElicitation: (response: ElicitationInteractionResponse, signal: AbortSignal) => void;
}

export function createSessionInteractionStore(ports: {
    readonly permission: (response: PermissionInteractionResponse, signal: AbortSignal) => Promise<void>;
    readonly elicitation: (response: ElicitationInteractionResponse, signal: AbortSignal) => Promise<void>;
}) {
    return createStore<SessionInteractionStore>()((set, get) => {
        const submit = (id: string, signal: AbortSignal, respond: () => Promise<void>): void => {
            if (signal.aborted || get().operation.kind === "submitting" || get().submitted.has(id)) {
                return;
            }
            set({ operation: { kind: "submitting", interactionId: id } });
            void respond().then(
                () => {
                    if (!signal.aborted) {
                        set((current) => ({
                            operation: { kind: "idle" },
                            submitted: new Set([...current.submitted, id]),
                        }));
                    }
                },
                (cause: unknown) => {
                    if (signal.aborted) {
                        return;
                    }
                    set({
                        operation: {
                            kind: "failed",
                            interactionId: id,
                            message: formatError(cause, "The response could not be submitted."),
                        },
                    });
                },
            );
        };
        return {
            operation: { kind: "idle" },
            submitted: new Set(),
            respondToPermission: (response, signal) =>
                submit(response.interactionId, signal, () => ports.permission(response, signal)),
            respondToElicitation: (response, signal) =>
                submit(response.interactionId, signal, () => ports.elicitation(response, signal)),
        };
    });
}

export function sessionInteractionPresentation(
    interactions: readonly (
        | { readonly kind: "permission"; readonly permission: PermissionInteraction }
        | { readonly kind: "elicitation"; readonly elicitation: ElicitationInteraction }
    )[],
    model: SessionInteractionStore,
) {
    return {
        permissions: interactions.flatMap((interaction) =>
            interaction.kind === "permission" &&
            interaction.permission.state.kind === "pending" &&
            !model.submitted.has(interaction.permission.interactionId)
                ? [interaction.permission]
                : [],
        ),
        elicitations: interactions.flatMap((interaction) =>
            interaction.kind === "elicitation" &&
            interaction.elicitation.state.kind === "pending" &&
            !model.submitted.has(interaction.elicitation.interactionId)
                ? [interaction.elicitation]
                : [],
        ),
        busyInteractionId: model.operation.kind === "submitting" ? model.operation.interactionId : "",
        error: model.operation.kind === "failed" ? model.operation.message : "",
    };
}
