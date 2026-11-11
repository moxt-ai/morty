import { PROJECT_PERMISSION_NAMES, type ProjectPermissionName } from "@morty-build/client/protocol";
import type { ComputerScope } from "../do/session.ts";
import type { HttpError } from "../http-error.ts";
import { VerifiedChannelAccess } from "../pairing/pairing.ts";

export class ProjectPermission {
    // The vocabulary is defined once by the protocol; each name has exactly one instance.
    static readonly #byName: ReadonlyMap<string, ProjectPermission> = new Map(
        PROJECT_PERMISSION_NAMES.map((name) => [name, new ProjectPermission(name)]),
    );

    static readonly named = (name: ProjectPermissionName): ProjectPermission => {
        const permission = ProjectPermission.#byName.get(name);
        if (permission === undefined) {
            throw new Error(`Project permission ${name} is missing from the vocabulary`);
        }
        return permission;
    };
    static readonly RuntimePair = ProjectPermission.named("runtime:pair");
    static readonly RuntimeRead = ProjectPermission.named("runtime:read");
    static readonly RuntimeRevoke = ProjectPermission.named("runtime:revoke");
    static readonly SessionRead = ProjectPermission.named("session:read");
    static readonly SessionWrite = ProjectPermission.named("session:write");

    readonly value: ProjectPermissionName;

    private constructor(value: ProjectPermissionName) {
        this.value = value;
    }

    readonly toJSON = (): string => this.value;
}

/**
 * What a project credential must grant to open a Runtime host connection and to keep using it. The connection
 * receives the Runtime's status and every Session's traffic, so it needs to read both. Each command the connection
 * sends additionally needs that command's own permission.
 */
export const PROJECT_HOST_PERMISSIONS: readonly ProjectPermission[] = Object.freeze([
    ProjectPermission.RuntimeRead,
    ProjectPermission.SessionRead,
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

export class ProjectAccessContext {
    readonly actor: AuditActor;
    readonly permissions: ReadonlySet<ProjectPermission>;
    readonly scope: ComputerScope;

    get computerId(): string {
        return this.scope.computerId;
    }

    constructor(scope: ComputerScope, permissions: ReadonlySet<ProjectPermission>, actor: AuditActor) {
        this.scope = scope;
        this.permissions = new Set(permissions);
        this.actor = actor;
    }

    readonly permits = (permission: ProjectPermission): boolean => this.permissions.has(permission);
}

export class ProjectAuthenticationError extends Error implements HttpError {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "ProjectAuthenticationError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: projectAuthenticationErrorStatus(this.code),
    });
}

function projectAuthenticationErrorStatus(code: string): number {
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

export class RuntimeAccessContext extends VerifiedChannelAccess {
    readonly scope: ComputerScope;

    constructor(scope: ComputerScope) {
        super(scope.computerId, []);
        this.scope = scope;
    }
}
