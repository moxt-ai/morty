import { COMPUTER_PERMISSION_NAMES, type ComputerPermissionName } from "@morty-build/client/protocol";
import type { ComputerScope } from "../do/session.ts";
import type { HttpError } from "../http-error.ts";
import { VerifiedComputerAccess } from "../pairing/pairing.ts";

export class ComputerPermission {
    // The vocabulary is defined once by the protocol; each name has exactly one instance.
    static readonly #byName: ReadonlyMap<string, ComputerPermission> = new Map(
        COMPUTER_PERMISSION_NAMES.map((name) => [name, new ComputerPermission(name)]),
    );

    static readonly named = (name: ComputerPermissionName): ComputerPermission => {
        const permission = ComputerPermission.#byName.get(name);
        if (permission === undefined) {
            throw new Error(`Computer permission ${name} is missing from the vocabulary`);
        }
        return permission;
    };
    static readonly RuntimePair = ComputerPermission.named("runtime:pair");
    static readonly RuntimeRead = ComputerPermission.named("runtime:read");
    static readonly RuntimeRevoke = ComputerPermission.named("runtime:revoke");
    static readonly SessionRead = ComputerPermission.named("session:read");
    static readonly SessionWrite = ComputerPermission.named("session:write");

    readonly value: ComputerPermissionName;

    private constructor(value: ComputerPermissionName) {
        this.value = value;
    }

    readonly toJSON = (): string => this.value;
}

/**
 * What a project credential must grant to open a Runtime host connection and to keep using it. The connection
 * receives the Runtime's status and every Session's traffic, so it needs to read both. Each command the connection
 * sends additionally needs that command's own permission.
 */
export const COMPUTER_HOST_PERMISSIONS: readonly ComputerPermission[] = Object.freeze([
    ComputerPermission.RuntimeRead,
    ComputerPermission.SessionRead,
]);

export class AuditActorKind {
    readonly value: string;

    protected constructor(value: string) {
        this.value = value;
    }

    readonly toJSON = (): string => this.value;
}

export class AuditActor {
    readonly actorId: string;
    readonly kind: AuditActorKind;

    constructor(kind: AuditActorKind, actorId: string) {
        this.kind = kind;
        this.actorId = actorId;
    }
}

export class ComputerAccessContext {
    readonly actor: AuditActor;
    readonly permissions: ReadonlySet<ComputerPermission>;
    readonly scope: ComputerScope;

    get computerId(): string {
        return this.scope.computerId;
    }

    constructor(scope: ComputerScope, permissions: ReadonlySet<ComputerPermission>, actor: AuditActor) {
        this.scope = scope;
        this.permissions = new Set(permissions);
        this.actor = actor;
    }

    readonly permits = (permission: ComputerPermission): boolean => this.permissions.has(permission);
}

export class ComputerAuthenticationError extends Error implements HttpError {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "ComputerAuthenticationError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: computerAuthenticationErrorStatus(this.code),
    });
}

function computerAuthenticationErrorStatus(code: string): number {
    switch (code) {
        case "credential_expired":
        case "credential_revoked":
        case "project_credential_invalid":
            return 401;
        case "project_access_denied":
        case "project_permission_denied":
            return 403;
        default:
            return 503;
    }
}

export class RuntimeAccessContext extends VerifiedComputerAccess {
    readonly scope: ComputerScope;

    constructor(scope: ComputerScope) {
        super(scope.computerId, []);
        this.scope = scope;
    }
}
