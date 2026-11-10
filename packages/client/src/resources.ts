import {
    decodeIdentifier,
    decodeSessionCapabilities,
    decodeTurn,
    type Identifier,
    isIdentifier,
    type NativeSessionTarget,
    type PromptAttachment,
    readNativeSessionTarget,
    type SessionCapabilities,
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

function booleanField(value: Readonly<Record<string, unknown>>, field: string): boolean {
    const candidate = value[field];
    if (typeof candidate !== "boolean") {
        throw invalidResponse(`The service returned an invalid ${field}`);
    }
    return candidate;
}

function arrayField(
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
        if (!/^msession_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(this.credential)) {
            throw invalidResponse("The Session credential is invalid");
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

/** A revocation of a Project's Session credentials: every one issued no later than `revokedThrough`. */
export class MortySessionAccessRevocation {
    readonly revokedThrough: string;
    constructor(value: unknown) {
        const resource = record(value, "Session access revocation");
        this.revokedThrough = validateTimestamp(stringField(resource, "revokedThrough", 128), "revokedThrough");
    }
}

/** Creates an Agent-owned Session with its initial settings. Reuse the operation ID after response loss. */
export interface CreateMortySessionRequest {
    readonly harness: string;
    readonly configurations: readonly SessionConfigurationSelection[];
    readonly directory: string;
    readonly computerId: string;
    readonly operationId: string;
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

export class MortyRuntimePairingRequest {
    readonly idempotencyKey: string;

    constructor(idempotencyKey: string) {
        if (!isIdentifier(idempotencyKey)) {
            throw new MortyValidationError("The Runtime pairing idempotency key is invalid");
        }
        this.idempotencyKey = idempotencyKey;
    }
}

export class MortyAgentDescriptor {
    readonly agentPath: string;
    readonly agentVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly harness: string;
    readonly label: string;

    constructor(
        agentPath: string,
        agentVersion: string,
        capabilities: SessionCapabilities,
        harness: string,
        label: string,
    ) {
        this.agentPath = agentPath;
        this.agentVersion = agentVersion;
        this.capabilities = Object.freeze({ ...capabilities });
        this.harness = harness;
        this.label = label;
    }
}

export function decodeMortyAgentCapabilities(value: unknown): SessionCapabilities {
    try {
        return decodeSessionCapabilities(value);
    } catch (cause) {
        throw new MortyProtocolError("The service returned invalid Agent capabilities", { cause });
    }
}

function decodeAgentDescriptor(value: unknown): MortyAgentDescriptor {
    const agent = record(value, "Agent descriptor");
    if (
        !Object.hasOwn(agent, "agentPath") ||
        !Object.hasOwn(agent, "agentVersion") ||
        !Object.hasOwn(agent, "capabilities") ||
        !Object.hasOwn(agent, "harness") ||
        !Object.hasOwn(agent, "label")
    ) {
        throw invalidResponse("The service returned an invalid Agent descriptor");
    }
    const agentPath = stringField(agent, "agentPath", 4_096);
    const agentVersion = stringField(agent, "agentVersion", 128);
    const label = stringField(agent, "label", 80);
    if (agentPath.trim().length === 0 || agentVersion.trim().length === 0 || label.trim().length === 0) {
        throw invalidResponse("The service returned an invalid Agent descriptor");
    }
    return new MortyAgentDescriptor(
        agentPath,
        agentVersion,
        decodeMortyAgentCapabilities(agent["capabilities"]),
        identifierField(agent, "harness"),
        label.trim(),
    );
}

export class MortyRuntimeDescriptor {
    readonly agents: readonly MortyAgentDescriptor[];
    readonly machineName: string;
    readonly online: boolean;
    readonly computerId: string;
    readonly workspaceName: string;

    constructor(
        agents: readonly MortyAgentDescriptor[],
        machineName: string,
        online: boolean,
        computerId: string,
        workspaceName: string,
    ) {
        this.agents = agents;
        this.computerId = computerId;
        this.machineName = machineName;
        this.online = online;
        this.workspaceName = workspaceName;
    }
}

export function decodeRuntimeDescriptor(value: unknown): MortyRuntimeDescriptor {
    const runtime = record(value, "Runtime descriptor");
    return new MortyRuntimeDescriptor(
        arrayField(runtime, "agents", 100).map(decodeAgentDescriptor),
        stringField(runtime, "machineName", 255),
        booleanField(runtime, "online"),
        identifierField(runtime, "computerId"),
        stringField(runtime, "workspaceName", 255),
    );
}

export function decodeMortyRuntimeList(value: unknown): readonly MortyRuntimeDescriptor[] {
    const response = record(value, "Runtime list");
    return arrayField(response, "runtimes", 100).map(decodeRuntimeDescriptor);
}

export class MortyRuntimePairing {
    readonly expiresAt: string;
    readonly pairingCode: string;
    readonly pollToken: string;
    readonly computerId: string;

    constructor(expiresAt: string, pairingCode: string, pollToken: string, computerId: string) {
        this.computerId = computerId;
        this.expiresAt = expiresAt;
        this.pairingCode = pairingCode;
        this.pollToken = pollToken;
    }
}

export class MortyRuntimePairingWaitOptions {
    readonly pollIntervalMilliseconds: number;
    readonly timeoutMilliseconds: number;

    constructor(timeoutMilliseconds = 120_000, pollIntervalMilliseconds = 1_000) {
        if (
            !Number.isSafeInteger(timeoutMilliseconds) ||
            timeoutMilliseconds < 1 ||
            timeoutMilliseconds > 30 * 60 * 1_000 ||
            !Number.isSafeInteger(pollIntervalMilliseconds) ||
            pollIntervalMilliseconds < 1 ||
            pollIntervalMilliseconds > timeoutMilliseconds
        ) {
            throw new MortyValidationError("The Runtime pairing wait bounds are invalid");
        }
        this.pollIntervalMilliseconds = pollIntervalMilliseconds;
        this.timeoutMilliseconds = timeoutMilliseconds;
    }
}

export function decodeMortyRuntimePairing(value: unknown): MortyRuntimePairing {
    const pairing = record(value, "Runtime pairing");
    const pairingCode = stringField(pairing, "pairingCode", 24);
    const pollToken = stringField(pairing, "pollToken", 256);
    if (
        !/^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/.test(pairingCode) ||
        !/^[a-zA-Z0-9_-]{32,256}$/.test(pollToken)
    ) {
        throw invalidResponse("The service returned invalid Runtime pairing credentials");
    }
    return new MortyRuntimePairing(
        validateTimestamp(stringField(pairing, "expiresAt", 128), "expiresAt"),
        pairingCode,
        pollToken,
        identifierField(pairing, "computerId"),
    );
}

export const MortyRuntimePairingLifecycle = Object.freeze({
    Expired: "expired",
    Paired: "paired",
    Pending: "pending",
    Revoked: "revoked",
});

export abstract class MortyRuntimePairingStatus {
    abstract readonly status: string;
}

export class MortyPendingRuntimePairingStatus extends MortyRuntimePairingStatus {
    readonly expiresAt: string;
    readonly status = MortyRuntimePairingLifecycle.Pending;

    constructor(expiresAt: string) {
        super();
        this.expiresAt = expiresAt;
    }
}

export class MortyExpiredRuntimePairingStatus extends MortyRuntimePairingStatus {
    readonly status = MortyRuntimePairingLifecycle.Expired;
}

export class MortyPairedRuntimePairingStatus extends MortyRuntimePairingStatus {
    readonly agents: readonly MortyAgentDescriptor[];
    readonly machineName: string;
    readonly computerId: string;
    readonly status = MortyRuntimePairingLifecycle.Paired;
    readonly workspaceName: string;

    constructor(
        agents: readonly MortyAgentDescriptor[],
        machineName: string,
        computerId: string,
        workspaceName: string,
    ) {
        super();
        this.agents = agents;
        this.computerId = computerId;
        this.machineName = machineName;
        this.workspaceName = workspaceName;
    }
}

export class MortyRevokedRuntimePairingStatus extends MortyRuntimePairingStatus {
    readonly revokedAt: string;
    readonly status = MortyRuntimePairingLifecycle.Revoked;

    constructor(revokedAt: string) {
        super();
        this.revokedAt = revokedAt;
    }
}

export function decodeMortyRuntimePairingStatus(value: unknown): MortyRuntimePairingStatus {
    const status = record(value, "Runtime pairing status");
    const lifecycle = stringField(status, "status", 32);
    if (lifecycle === MortyRuntimePairingLifecycle.Pending) {
        return new MortyPendingRuntimePairingStatus(
            validateTimestamp(stringField(status, "expiresAt", 128), "expiresAt"),
        );
    }
    if (lifecycle === MortyRuntimePairingLifecycle.Expired) {
        return new MortyExpiredRuntimePairingStatus();
    }
    if (lifecycle === MortyRuntimePairingLifecycle.Revoked) {
        return new MortyRevokedRuntimePairingStatus(
            validateTimestamp(stringField(status, "revokedAt", 128), "revokedAt"),
        );
    }
    if (lifecycle === MortyRuntimePairingLifecycle.Paired) {
        return new MortyPairedRuntimePairingStatus(
            arrayField(status, "agents", 100).map(decodeAgentDescriptor),
            stringField(status, "machineName", 255),
            identifierField(status, "computerId"),
            stringField(status, "workspaceName", 255),
        );
    }
    throw invalidResponse("The service returned an unsupported Runtime pairing status");
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
