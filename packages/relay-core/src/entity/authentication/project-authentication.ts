import type { ProjectPermissionName } from "@morty-build/client/protocol";
import type { ComputerScope } from "../do/session.ts";
import type { HttpError } from "../http-error.ts";

export type ProjectPermission = ProjectPermissionName;

export const ProjectPermission = {
    ComputerPair: "computer:pair",
    ComputerRead: "computer:read",
    ComputerRevoke: "computer:revoke",
    SessionRead: "session:read",
    SessionWrite: "session:write",
} as const satisfies Readonly<Record<string, ProjectPermission>>;

/**
 * What a project credential must grant to open a Computer host connection and to keep using it. The connection
 * receives the Computer's status and every Session's traffic, so it needs to read both. Each command the connection
 * sends additionally needs that command's own permission.
 */
export const PROJECT_HOST_PERMISSIONS: readonly ProjectPermission[] = Object.freeze([
    ProjectPermission.ComputerRead,
    ProjectPermission.SessionRead,
]);

export interface AuditActor {
    readonly actorId: string;
    readonly kind: "application";
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
