import type { ProjectLocationHint } from "@morty-build/client/protocol";
import {
    AuditActorKind,
    type HttpError,
    type ProjectAccessContext,
    type ProjectPermission,
} from "@morty-build/relay-core/contracts";

export class RelayAuditActorKind extends AuditActorKind {
    static readonly Application = new RelayAuditActorKind("application");
}

export class ComputerManagementError extends Error implements HttpError {
    readonly code: string;
    readonly status: number;

    constructor(code: string, message: string, status: number, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "ComputerManagementError";
        this.status = status;
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.status,
    });
}

export class RelayAuthenticationConfiguration {
    readonly allowedOrigins: ReadonlySet<string>;
    constructor(allowedOrigins: ReadonlySet<string> = new Set()) {
        if ([...allowedOrigins].some((origin) => origin !== "*" && !validOrigin(origin))) {
            throw new ComputerManagementError("relay_configuration_invalid", "A Relay browser origin is invalid", 500);
        }
        this.allowedOrigins = new Set(allowedOrigins);
    }
}

export class RelayAppCredentialAccess {
    readonly appId: string;
    readonly publicCredentialId: string;
    readonly project: ProjectAccessContext;

    constructor(appId: string, publicCredentialId: string, project: ProjectAccessContext) {
        this.appId = appId;
        this.publicCredentialId = publicCredentialId;
        this.project = project;
    }
}

export interface RelayApplicationIdentity {
    readonly kind: "application";
    readonly publicCredentialId: string;
    readonly appId: string;
    readonly credentialId: string;
    readonly permissions: ReadonlySet<ProjectPermission>;
    readonly scope: "all-projects" | "selected-projects";
}

export type RelayPrincipal = RelayApplicationIdentity;

export interface ComputerManagementPlacement {
    readonly locationHint: ProjectLocationHint;
}

export interface ComputerManagementPlacementRegistry {
    readonly resolveLocationHint: (locationHint: string) => ComputerManagementPlacement | null;
    readonly supports: (placement: ComputerManagementPlacement) => boolean;
}

export function hasControlCharacters(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 31 || codePoint === 127) {
            return true;
        }
    }
    return false;
}

function validOrigin(value: string): boolean {
    if (value.length === 0 || value.length > 2_048 || value === "*") {
        return false;
    }
    try {
        const parsed = new URL(value);
        return (
            (parsed.protocol === "https:" || parsed.protocol === "http:") &&
            parsed.origin === value &&
            parsed.username.length === 0 &&
            parsed.password.length === 0 &&
            parsed.pathname === "/" &&
            parsed.search.length === 0 &&
            parsed.hash.length === 0
        );
    } catch {
        return false;
    }
}
