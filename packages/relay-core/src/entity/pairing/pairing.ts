import {
    decodeSessionCapabilities,
    isIdentifier,
    MAX_LOCAL_AGENT_DIRECTORY_ENTRIES,
    type SessionCapabilities,
} from "@morty-build/client/protocol";
import type { HttpError } from "../http-error.ts";

export const PAIRING_LIFETIME_MILLISECONDS = 10 * 60 * 1_000;

const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
export interface AgentDescriptor {
    readonly agentPath: string;
    readonly agentVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly harness: string;
    readonly label: string;
}

export class CreatedRuntimePairing {
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

export interface ClaimedPairing {
    readonly computerId: string;
    readonly daemonToken: string;
}

export class VerifiedChannelAccess {
    readonly agents: readonly AgentDescriptor[];
    readonly computerId: string;

    constructor(computerId: string, agents: readonly AgentDescriptor[]) {
        this.agents = agents;
        this.computerId = computerId;
    }
}

/**
 * A host connection opened with a project credential. The Relay stores no copy of that authority: the connection
 * names the credential, and every message it sends re-reads whether the credential still grants
 * `PROJECT_HOST_PERMISSIONS` and the message's own permission in the Project.
 */
export class ProjectCredentialHostAccess extends VerifiedChannelAccess {
    readonly credentialId: string;

    constructor(computerId: string, credentialId: string) {
        super(computerId, []);
        this.credentialId = credentialId;
    }
}

/** The credential whose authority keeps a host connection open: the project credential that opened it. */
export interface HostCredential {
    readonly credentialId: string;
}

export class ChannelDescriptor {
    readonly agents: readonly AgentDescriptor[];
    readonly machineName: string;
    readonly computerId: string;
    readonly workspaceName: string;

    constructor(agents: readonly AgentDescriptor[], machineName: string, workspaceName: string, computerId: string) {
        this.agents = agents.map((agent) => ({
            ...agent,
            agentSettingsDiscovery: true,
            sessionTurnConfiguration: true,
        }));
        this.computerId = computerId;
        this.machineName = machineName;
        this.workspaceName = workspaceName;
    }
}

export const PairingLifecycle = Object.freeze({
    Expired: "expired",
    Paired: "paired",
    Pending: "pending",
    Revoked: "revoked",
});

export abstract class PairingStatus {
    abstract readonly status: string;
}

export class PendingPairingStatus extends PairingStatus {
    readonly expiresAt: string;
    readonly status = PairingLifecycle.Pending;

    constructor(expiresAt: string) {
        super();
        this.expiresAt = expiresAt;
    }
}

export class ExpiredPairingStatus extends PairingStatus {
    readonly status = PairingLifecycle.Expired;
}

export class PairedPairingStatus extends PairingStatus {
    readonly agents: readonly AgentDescriptor[];
    readonly machineName: string;
    readonly computerId: string;
    readonly status = PairingLifecycle.Paired;
    readonly workspaceName: string;

    constructor(agents: readonly AgentDescriptor[], machineName: string, workspaceName: string, computerId: string) {
        super();
        this.agents = agents;
        this.computerId = computerId;
        this.machineName = machineName;
        this.workspaceName = workspaceName;
    }
}

export class RevokedPairingStatus extends PairingStatus {
    readonly revokedAt: string;
    readonly status = PairingLifecycle.Revoked;

    constructor(revokedAt: string) {
        super();
        this.revokedAt = revokedAt;
    }
}

export class PairingDirectoryError extends Error implements HttpError {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "PairingDirectoryError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: pairingDirectoryErrorStatus(this.code),
    });
}

function pairingDirectoryErrorStatus(code: string): number {
    switch (code) {
        case "pairing_not_found":
        case "runtime_not_found":
        case "channel_not_found":
            return 404;
        case "unauthorized":
        case "runtime_revoked":
            return 401;
        case "runtime_access_denied":
        case "workspace_required":
            return 403;
        case "runtime_unavailable":
        case "idempotency_conflict":
        case "session_configuration_conflict":
        case "turn_already_started":
            return 409;
        case "pairing_timeout":
        case "directory_timeout":
            return 504;
        case "runtime_quota_exceeded":
            return 429;
        case "directory_unavailable":
        case "runtime_disconnect_failed":
            return 503;
        default:
            return 400;
    }
}

export class RevokedProjectRuntime {
    readonly access: VerifiedChannelAccess;
    readonly revokedAt: string;

    constructor(access: VerifiedChannelAccess, revokedAt: string) {
        this.access = access;
        this.revokedAt = revokedAt;
    }
}

export function createRandomToken(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function createRandomPairingCode(): string {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    let code = "";
    for (const byte of bytes) {
        code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
    }
    return code.match(/.{1,4}/g)?.join("-") ?? code;
}

export function normalizePairingCode(code: string): string {
    const normalized = code.trim().toUpperCase();
    if (!PAIRING_CODE_PATTERN.test(normalized)) {
        throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
    }
    return normalized;
}

export async function hashSecret(secret: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Morty's authorized fresh-enrollment cutover leaves old records readable but old bearer hashes unusable. */
export async function hashPairingCredential(secret: string): Promise<string> {
    return await hashSecret(`morty-pairing-v2\0${secret}`);
}

export function parseAgents(encoded: string): readonly AgentDescriptor[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (error) {
        throw new PairingDirectoryError("invalid_directory_record", "The paired agent directory is invalid", {
            cause: error,
        });
    }
    return validateAgents(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAgentCapabilities(value: unknown): SessionCapabilities {
    try {
        return decodeSessionCapabilities(value);
    } catch (cause) {
        throw new PairingDirectoryError("invalid_agents", "The Agent capability catalog is invalid", { cause });
    }
}

export function validateAgents(value: unknown): readonly AgentDescriptor[] {
    if (!Array.isArray(value) || value.length > MAX_LOCAL_AGENT_DIRECTORY_ENTRIES) {
        throw new PairingDirectoryError("invalid_agents", "The ready Agent directory is invalid");
    }

    const agents: AgentDescriptor[] = [];
    const identifiers = new Set<string>();
    for (const candidate of value) {
        if (
            !isRecord(candidate) ||
            !Object.hasOwn(candidate, "agentPath") ||
            !Object.hasOwn(candidate, "agentVersion") ||
            !Object.hasOwn(candidate, "capabilities") ||
            !Object.hasOwn(candidate, "harness") ||
            !Object.hasOwn(candidate, "label")
        ) {
            throw new PairingDirectoryError("invalid_agents", "The local agent directory is invalid");
        }
        const capabilities = validateAgentCapabilities(candidate["capabilities"]);
        const harness = candidate["harness"];
        const label = candidate["label"];
        const agentPath = candidate["agentPath"];
        const agentVersion = candidate["agentVersion"];
        if (
            typeof agentPath !== "string" ||
            agentPath.trim().length === 0 ||
            agentPath.length > 4_096 ||
            typeof agentVersion !== "string" ||
            agentVersion.trim().length === 0 ||
            agentVersion.length > 128 ||
            typeof harness !== "string" ||
            !isIdentifier(harness) ||
            typeof label !== "string" ||
            label.trim().length === 0 ||
            label.length > 80 ||
            identifiers.has(harness)
        ) {
            throw new PairingDirectoryError("invalid_agents", "The local agent directory is invalid");
        }
        identifiers.add(harness);
        agents.push({
            agentPath,
            agentVersion: agentVersion.trim(),
            capabilities,
            harness,
            label: label.trim(),
        });
    }
    return agents;
}

export function validateDisplayName(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new PairingDirectoryError(`invalid_${field}`, `The ${field.replaceAll("_", " ")} is invalid`);
    }
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 120) {
        throw new PairingDirectoryError(`invalid_${field}`, `The ${field.replaceAll("_", " ")} is invalid`);
    }
    return normalized;
}

export function validatePairingCode(value: unknown): string {
    if (typeof value !== "string") {
        throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
    }
    return normalizePairingCode(value);
}

export function validateIdentifier(value: string, field: string): string {
    if (!isIdentifier(value)) {
        throw new PairingDirectoryError(`invalid_${field}`, `The ${field.replaceAll("_", " ")} is invalid`);
    }
    return value;
}

export function validateToken(value: string): string {
    if (!TOKEN_PATTERN.test(value)) {
        throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
    }
    return value;
}
