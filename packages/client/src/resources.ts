import {
    decodeIdentifier,
    decodeSessionAccessCredential,
    decodeTurn,
    type Identifier,
    type NativeSessionTarget,
    type PromptAttachment,
    readNativeSessionTarget,
    type SessionConfigurationSelection,
    type SessionPromptDisposition,
    type TurnRequest,
} from "@morty-build/client/protocol";

import { MortyProtocolError, MortyValidationError } from "./errors.ts";

function invalidResponse(message: string): MortyProtocolError {
    return new MortyProtocolError(message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
        throw invalidResponse(`The service returned an invalid ${name}`);
    }
    return value;
}

function stringField(value: Readonly<Record<string, unknown>>, field: string, maximumLength = 8_500_000): string {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length > maximumLength) {
        throw invalidResponse(`The service returned an invalid ${field}`);
    }
    return candidate;
}

function identifierField(value: Readonly<Record<string, unknown>>, field: string): Identifier {
    try {
        return decodeIdentifier(value[field]);
    } catch {
        throw invalidResponse(`The service returned an invalid ${field}`);
    }
}

function _booleanField(value: Readonly<Record<string, unknown>>, field: string): boolean {
    const candidate = value[field];
    if (typeof candidate !== "boolean") {
        throw invalidResponse(`The service returned an invalid ${field}`);
    }
    return candidate;
}

function _arrayField(
    value: Readonly<Record<string, unknown>>,
    field: string,
    maximumLength = 10_000,
): readonly unknown[] {
    const candidate = value[field];
    if (!Array.isArray(candidate) || candidate.length > maximumLength) {
        throw invalidResponse(`The service returned an invalid ${field}`);
    }
    return candidate;
}

function validateTimestamp(value: string, field: string): string {
    if (Number.isNaN(Date.parse(value))) {
        throw invalidResponse(`The service returned an invalid ${field}`);
    }
    return value;
}

export class MortySessionAccess {
    readonly credential: string;
    readonly computerId: string;
    readonly target: NativeSessionTarget;
    readonly expiresAt: string;
    constructor(value: unknown) {
        const resource = record(value, "Session access");
        this.credential = stringField(resource, "credential", 2_048);
        try {
            decodeSessionAccessCredential(this.credential);
        } catch (cause) {
            throw new MortyProtocolError("The Session credential is invalid", { cause });
        }
        this.computerId = identifierField(resource, "computerId");
        const target = readNativeSessionTarget(resource["target"]);
        if (target === null) {
            throw invalidResponse("The service returned an invalid native Session target");
        }
        this.target = target;
        this.expiresAt = validateTimestamp(stringField(resource, "expiresAt", 128), "expiresAt");
    }
}

/** A Turn's content. The Runtime runs it with the Agent and directory of the Session it holds. */
interface SubmitMortyTurnContent {
    readonly attachments: readonly PromptAttachment[];
    readonly content: string;
    readonly idempotencyKey: string;
    readonly sessionConfigurations?: readonly SessionConfigurationSelection[];
}

/**
 * A Turn submission. Without a disposition the message is appended: the Runtime runs it now or queues it behind the
 * Session's earlier work and answers which. A steering submission joins the running Turn it names, and is refused,
 * leaving its idempotency key unused, when that Turn is not running.
 */
export type SubmitMortyTurnRequest = SubmitMortyTurnContent &
    (
        | { readonly disposition?: typeof SessionPromptDisposition.Append }
        | { readonly disposition: typeof SessionPromptDisposition.Steer; readonly targetCommandId: string }
    );

/** How a cancelled Turn ended: `cancelled`, or the Agent's stop reason when the Turn finished first. */
export interface MortyTurnCancellation {
    readonly turnId: string;
    readonly stopReason: string;
}

export abstract class MortyInteractionResponseRequest {
    abstract readonly kind: string;
    readonly responderId: string;

    constructor(responderId: string) {
        this.responderId = responderId;
    }
}

export class MortyPermissionResponseRequest extends MortyInteractionResponseRequest {
    readonly kind = "permission";
    readonly optionId: string;
    readonly outcome: string;

    constructor(responderId: string, outcome: string, optionId: string) {
        super(responderId);
        this.optionId = optionId;
        this.outcome = outcome;
    }
}

export class MortyElicitationResponseRequest extends MortyInteractionResponseRequest {
    readonly action: string;
    readonly content: string;
    readonly kind = "elicitation";

    constructor(responderId: string, action: string, content: string) {
        super(responderId);
        this.action = action;
        this.content = content;
    }
}

export class MortyPageRequest {
    readonly cursor: string;
    readonly limit: number;

    constructor(limit: number, cursor: string) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || cursor.length > 512) {
            throw new MortyValidationError("The page request is invalid");
        }
        this.cursor = cursor;
        this.limit = limit;
    }
}

export abstract class MortyTurnState {
    abstract readonly kind: string;
}

export class MortyQueuedTurnState extends MortyTurnState {
    readonly kind = "queued";
}

export class MortyRunningTurnState extends MortyTurnState {
    readonly kind = "running";
    readonly startedAt: string;

    constructor(startedAt: string) {
        super();
        this.startedAt = startedAt;
    }
}

export class MortySucceededTurnState extends MortyTurnState {
    readonly completedAt: string;
    readonly kind = "succeeded";
    readonly stopReason: string;

    constructor(completedAt: string, stopReason: string) {
        super();
        this.completedAt = completedAt;
        this.stopReason = stopReason;
    }
}

export class MortyFailedTurnState extends MortyTurnState {
    readonly code: string;
    readonly failedAt: string;
    readonly kind = "failed";
    readonly message: string;
    readonly retryable: boolean;

    constructor(failedAt: string, code: string, message: string, retryable: boolean) {
        super();
        this.code = code;
        this.failedAt = failedAt;
        this.message = message;
        this.retryable = retryable;
    }
}

export class MortyCancelledTurnState extends MortyTurnState {
    readonly cancelledAt: string;
    readonly kind = "cancelled";

    constructor(cancelledAt: string) {
        super();
        this.cancelledAt = cancelledAt;
    }
}

export class MortyIndeterminateTurnState extends MortyTurnState {
    readonly detectedAt: string;
    readonly kind = "indeterminate";
    readonly reason: string;

    constructor(detectedAt: string, reason: string) {
        super();
        this.detectedAt = detectedAt;
        this.reason = reason;
    }
}

export class MortyTurn {
    readonly acceptedAt: string;

    readonly idempotencyKey: string;
    readonly request: TurnRequest;
    readonly target: NativeSessionTarget;
    readonly state: MortyTurnState;
    readonly turnId: string;

    constructor(
        acceptedAt: string,
        content: string,
        idempotencyKey: string,
        target: NativeSessionTarget,
        sessionConfigurations: readonly SessionConfigurationSelection[],
        state: MortyTurnState,
        turnId: string,
        request: TurnRequest = { content, kind: "prompt", sessionConfigurations },
    ) {
        this.acceptedAt = acceptedAt;
        this.idempotencyKey = idempotencyKey;
        this.request = request;
        this.target = target;
        this.state = state;
        this.turnId = turnId;
    }

    get content(): string {
        return this.request.kind === "prompt" ? this.request.content : "";
    }

    get sessionConfigurations(): readonly SessionConfigurationSelection[] {
        return this.request.kind === "prompt" ? this.request.sessionConfigurations : [];
    }
}

export function decodeMortyTurn(value: unknown): MortyTurn | null {
    const turn = decodeTurn(value);
    if (turn === null) {
        return null;
    }
    let state: MortyTurnState;
    switch (turn.state.kind) {
        case "queued":
            state = new MortyQueuedTurnState();
            break;
        case "running":
            state = new MortyRunningTurnState(turn.state.startedAt);
            break;
        case "succeeded":
            state = new MortySucceededTurnState(turn.state.completedAt, turn.state.result.stopReason);
            break;
        case "failed":
            state = new MortyFailedTurnState(
                turn.state.failedAt,
                turn.state.error.code,
                turn.state.error.message,
                turn.state.error.retryable,
            );
            break;
        case "cancelled":
            state = new MortyCancelledTurnState(turn.state.cancelledAt);
            break;
        case "indeterminate":
            state = new MortyIndeterminateTurnState(
                turn.state.reconciliation.detectedAt,
                turn.state.reconciliation.reason,
            );
            break;
    }
    return new MortyTurn(
        turn.acceptedAt,
        turn.request.kind === "prompt" ? turn.request.content : "",
        turn.idempotencyKey,
        turn.target,
        turn.request.kind === "prompt" ? turn.request.sessionConfigurations : [],
        state,
        turn.turnId,
        turn.request,
    );
}
