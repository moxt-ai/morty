import type { HttpError } from "../../../entity/http-error.ts";
import type { ComputerScope } from "../../runtime/entity/session.ts";

export interface AuditActor {
    readonly actorId: string;
    readonly kind: "application";
}

export class ProjectAccessContext {
    readonly actor: AuditActor;
    readonly scope: ComputerScope;

    get computerId(): string {
        return this.scope.computerId;
    }

    constructor(scope: ComputerScope, actor: AuditActor) {
        this.scope = scope;
        this.actor = actor;
    }
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
