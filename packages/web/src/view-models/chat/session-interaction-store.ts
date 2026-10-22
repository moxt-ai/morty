import { createStore } from "zustand/vanilla";
import { formatError } from "../format-error.ts";
import type {
    ElicitationInteractionResponse,
    PermissionInteraction,
    PermissionInteractionResponse,
    SessionInteraction,
} from "./session-pane-types.ts";

type InteractionOperation =
    | { readonly kind: "submitting" }
    | { readonly kind: "submitted" }
    | { readonly kind: "failed"; readonly message: string };

export interface SessionInteractionStore {
    readonly submissions: ReadonlyMap<string, InteractionOperation>;
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
            submissions: new Map(),
            respondToPermission: (response, signal) =>
                submit(response.interactionId, signal, () => ports.permission(response, signal)),
            respondToElicitation: (response, signal) =>
                submit(response.interactionId, signal, () => ports.elicitation(response, signal)),
        };
    });
}

export function sessionInteractionPresentation(
    interactions: readonly SessionInteraction[],
    model: SessionInteractionStore,
) {
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
