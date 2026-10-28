import { createStore } from "zustand/vanilla";
import { formatError } from "../format-error.ts";
import type { SessionLifecycleFact } from "./session-lifecycle.ts";
import type {
    ElicitationInteractionResponse,
    PermissionInteraction,
    PermissionInteractionResponse,
    SessionInteraction,
} from "./session-pane-types.ts";

// The Session's interaction contract: the requests the Agent made, how each
// was resolved, and the user's in-flight responses. The pane forwards lifecycle
// facts here instead of tracking interactions itself.

/** A lifecycle fact that changes the interactions. */
type SessionInteractionFact = Extract<
    SessionLifecycleFact,
    { readonly kind: "interaction-requested" | "permission-resolved" | "elicitation-resolved" }
>;

function interactionId(interaction: SessionInteraction): string {
    return interaction.kind === "permission"
        ? interaction.permission.interactionId
        : interaction.elicitation.interactionId;
}

function transitionSessionInteractions(
    current: readonly SessionInteraction[],
    fact: SessionInteractionFact,
): readonly SessionInteraction[] {
    switch (fact.kind) {
        case "interaction-requested": {
            const id = interactionId(fact.interaction);
            return [...current.filter((interaction) => interactionId(interaction) !== id), fact.interaction];
        }
        case "permission-resolved":
            return current.map((interaction): SessionInteraction => {
                if (
                    interaction.kind !== "permission" ||
                    interaction.permission.interactionId !== fact.interactionId ||
                    interaction.permission.state.kind === "resolved"
                ) {
                    return interaction;
                }
                return {
                    kind: "permission",
                    permission: {
                        ...interaction.permission,
                        state: { kind: "resolved", optionId: fact.optionId, outcome: fact.outcome },
                    },
                };
            });
        case "elicitation-resolved":
            return current.map((interaction): SessionInteraction => {
                if (
                    interaction.kind !== "elicitation" ||
                    interaction.elicitation.interactionId !== fact.interactionId ||
                    interaction.elicitation.state.kind === "resolved"
                ) {
                    return interaction;
                }
                return {
                    kind: "elicitation",
                    elicitation: {
                        ...interaction.elicitation,
                        state: {
                            action: fact.action,
                            content:
                                interaction.elicitation.state.kind === "submitted"
                                    ? interaction.elicitation.state.content
                                    : "",
                            kind: "resolved",
                        },
                    },
                };
            });
        default:
            return fact satisfies never;
    }
}

type InteractionOperation =
    | { readonly kind: "submitting" }
    | { readonly kind: "submitted" }
    | { readonly kind: "failed"; readonly message: string };

export interface SessionInteractionStore {
    /** The Agent's requests in arrival order, each with its latest resolution. */
    readonly interactions: readonly SessionInteraction[];
    readonly submissions: ReadonlyMap<string, InteractionOperation>;
    readonly apply: (fact: SessionInteractionFact) => void;
    /** Replaces the interactions with those the Runtime reports for the Session now. */
    readonly restore: (interactions: readonly SessionInteraction[]) => void;
    readonly respondToPermission: (response: PermissionInteractionResponse, signal: AbortSignal) => void;
    readonly respondToElicitation: (response: ElicitationInteractionResponse, signal: AbortSignal) => void;
}

export function createSessionInteractionStore(ports: {
    readonly permission: (response: PermissionInteractionResponse, signal: AbortSignal) => Promise<void>;
    readonly elicitation: (response: ElicitationInteractionResponse, signal: AbortSignal) => Promise<void>;
}) {
    return createStore<SessionInteractionStore>()((set, get) => {
        const record = (id: string, operation: InteractionOperation): void => {
            set((current) => ({ submissions: new Map(current.submissions).set(id, operation) }));
        };
        const submit = (id: string, signal: AbortSignal, respond: () => Promise<void>): void => {
            // The next interaction may arrive before the previous response is acknowledged.
            const operation = get().submissions.get(id);
            if (signal.aborted || operation?.kind === "submitting" || operation?.kind === "submitted") {
                return;
            }
            record(id, { kind: "submitting" });
            void respond().then(
                () => {
                    if (!signal.aborted) {
                        record(id, { kind: "submitted" });
                    }
                },
                (cause: unknown) => {
                    if (signal.aborted) {
                        return;
                    }
                    record(id, {
                        kind: "failed",
                        message: formatError(cause, "The response could not be submitted."),
                    });
                },
            );
        };
        return {
            interactions: [],
            submissions: new Map(),
            apply: (fact) =>
                set((current) => ({ interactions: transitionSessionInteractions(current.interactions, fact) })),
            restore: (interactions) => set({ interactions }),
            respondToPermission: (response, signal) =>
                submit(response.interactionId, signal, () => ports.permission(response, signal)),
            respondToElicitation: (response, signal) =>
                submit(response.interactionId, signal, () => ports.elicitation(response, signal)),
        };
    });
}

export function sessionInteractionPresentation(model: SessionInteractionStore) {
    const interactions = model.interactions;
    const permissions = interactions.flatMap((interaction) =>
        interaction.kind === "permission" &&
        interaction.permission.state.kind === "pending" &&
        model.submissions.get(interaction.permission.interactionId)?.kind !== "submitted"
            ? [interaction.permission]
            : [],
    );
    const elicitations = interactions.flatMap((interaction) =>
        interaction.kind === "elicitation" &&
        interaction.elicitation.state.kind === "pending" &&
        model.submissions.get(interaction.elicitation.interactionId)?.kind !== "submitted"
            ? [interaction.elicitation]
            : [],
    );
    const visibleIds = new Set([...permissions, ...elicitations].map((interaction) => interaction.interactionId));
    return {
        permissions,
        elicitations,
        waitingFor:
            permissions.length > 0 ? ("permission" as const) : elicitations.length > 0 ? ("answer" as const) : null,
        busyInteractionIds: new Set(
            Array.from(model.submissions).flatMap(([id, operation]) => (operation.kind === "submitting" ? [id] : [])),
        ),
        error:
            Array.from(model.submissions).flatMap(([id, operation]) =>
                visibleIds.has(id) && operation.kind === "failed" ? [operation.message] : [],
            )[0] ?? "",
    };
}

export function permissionPresentation(permission: PermissionInteraction) {
    return {
        cwd: permission.details?.cwd ?? "Session working directory unavailable",
        input:
            permission.details?.rawInput == null
                ? "The agent did not provide the original tool input."
                : JSON.stringify(permission.details.rawInput, null, 2),
        locations: [
            ...new Set(
                permission.details?.locations.map((location) =>
                    location.line == null ? location.path : `${location.path}:${location.line}`,
                ) ?? [],
            ),
        ],
        options: permission.options.map((option) => {
            switch (option.kind) {
                case "allow_once":
                    return { ...option, label: `Allow: ${option.name}`, allow: true };
                case "allow_always":
                    return { ...option, label: `Allow: ${option.name}`, allow: true };
                case "reject_once":
                    return { ...option, label: `Deny: ${option.name}`, allow: false };
                case "reject_always":
                    return { ...option, label: `Deny: ${option.name}`, allow: false };
                default: {
                    const unexpected: never = option.kind;
                    throw new Error(`Unsupported permission option: ${unexpected}`);
                }
            }
        }),
    };
}
