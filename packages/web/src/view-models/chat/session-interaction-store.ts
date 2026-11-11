import { createStore } from "zustand/vanilla";
import type { AgentDisplayContent } from "../../components/agents/display-content.ts";
import type { ElicitationFieldValue } from "../../services/chat/elicitation-form.ts";
import { formatError } from "../format-error.ts";
import type {
    ElicitationInteractionResponse,
    PermissionInteraction,
    PermissionInteractionResponse,
    SessionInteraction,
} from "./session-pane-types.ts";
import type { SessionMessage } from "./session-presentation.ts";

// What the user does with the Agent's requests: the answers typed into its questions and the responses in flight. The
// requests themselves, and how each was resolved, are the Session's execution state (`session-execution.ts`). A
// response belongs to the Session, so switching panes does not end it.

type InteractionOperation =
    | { readonly kind: "submitting" }
    | { readonly kind: "submitted" }
    | { readonly kind: "failed"; readonly message: string };

/** The answers typed so far into each pending question, by question and then by field. */
export type ElicitationAnswerDrafts = ReadonlyMap<string, Readonly<Record<string, ElicitationFieldValue>>>;

export interface SessionInteractionStore {
    /** What the user typed into questions not yet answered; it belongs to the Session, not to this pane. */
    readonly answerDrafts: ElicitationAnswerDrafts;
    readonly editAnswer: (interactionId: string, fieldName: string, value: ElicitationFieldValue) => void;
    readonly submissions: ReadonlyMap<string, InteractionOperation>;
    /**
     * The Computer's account now leaves `pending` the questions still waiting for an answer. Drafts last only while
     * their question is pending; an answered or withdrawn question drops its draft.
     */
    readonly questionsChanged: (pending: ReadonlySet<string>) => void;
    readonly respondToPermission: (response: PermissionInteractionResponse, signal: AbortSignal) => void;
    readonly respondToElicitation: (response: ElicitationInteractionResponse, signal: AbortSignal) => void;
}

export function createSessionInteractionStore(ports: {
    readonly permission: (response: PermissionInteractionResponse, signal: AbortSignal) => Promise<void>;
    readonly elicitation: (response: ElicitationInteractionResponse, signal: AbortSignal) => Promise<void>;
    /** The answer drafts the Session kept, and where changes to them are kept. */
    readonly answerDrafts: ElicitationAnswerDrafts;
    readonly answerDraftsChanged: (drafts: ElicitationAnswerDrafts) => void;
}) {
    return createStore<SessionInteractionStore>()((set, get) => {
        const replaceAnswerDrafts = (drafts: ElicitationAnswerDrafts): void => {
            set({ answerDrafts: drafts });
            ports.answerDraftsChanged(drafts);
        };
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
                    if (get().answerDrafts.has(id)) {
                        replaceAnswerDrafts(new Map([...get().answerDrafts].filter(([draftId]) => draftId !== id)));
                    }
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
            answerDrafts: ports.answerDrafts,
            editAnswer: (interactionId, fieldName, value) => {
                const current = get().answerDrafts;
                replaceAnswerDrafts(
                    new Map(current).set(interactionId, { ...(current.get(interactionId) ?? {}), [fieldName]: value }),
                );
            },
            submissions: new Map(),
            questionsChanged: (pending) => {
                const drafts = get().answerDrafts;
                if ([...drafts.keys()].some((id) => !pending.has(id))) {
                    replaceAnswerDrafts(new Map([...drafts].filter(([id]) => pending.has(id))));
                }
            },
            respondToPermission: (response, signal) =>
                submit(response.interactionId, signal, () => ports.permission(response, signal)),
            respondToElicitation: (response, signal) =>
                submit(response.interactionId, signal, () => ports.elicitation(response, signal)),
        };
    });
}

export type PermissionFileChange = Extract<AgentDisplayContent, { readonly type: "diff" }>;

/**
 * The diffs of the tool call a permission asks about. A request names its tool call and may omit
 * what the Agent already announced for it, so the timeline's merged call is the one that carries them.
 */
function requestedFileChanges(
    messages: readonly SessionMessage[],
    toolCallId: string,
): readonly PermissionFileChange[] {
    const announced = messages
        .flatMap((message) =>
            message.role === "assistant" &&
            message.presentation.kind === "tool" &&
            message.presentation.entry.id === toolCallId
                ? [message.presentation.entry]
                : [],
        )
        .at(-1);
    return announced?.content.flatMap((content) => (content.type === "diff" ? [content] : [])) ?? [];
}

/** What the interaction cards show of the Agent's pending `interactions` and the user's responses to them. */
export function sessionInteractionPresentation(
    model: SessionInteractionStore,
    interactions: readonly SessionInteraction[],
    messages: readonly SessionMessage[],
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
        answerDrafts: model.answerDrafts,
        fileChanges: new Map(
            permissions.map((permission) => [
                permission.interactionId,
                requestedFileChanges(messages, permission.toolCallId),
            ]),
        ),
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
        cwd: permission.details.cwd,
        input:
            permission.details.rawInput == null
                ? "The agent did not provide the original tool input."
                : JSON.stringify(permission.details.rawInput, null, 2),
        locations: [
            ...new Set(
                permission.details.locations.map((location) =>
                    location.line == null ? location.path : `${location.path}:${location.line}`,
                ),
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
