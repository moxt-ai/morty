import {
    decodeIdentifier,
    type Identifier,
    isIdentifier,
    type ProjectLocationHint,
} from "@morty-build/client/protocol";

import { MortyProtocolError, MortyValidationError } from "./errors.ts";

import { type MortyEndpointOptions, MortyRequestExecutor, StaticMortyCredentialProvider } from "./service-client.ts";

export { MORTY_API_PREFIX } from "@morty-build/client/protocol";

export {
    MortyApiError,
    MortyCancellationError,
    MortyConnectionError,
    MortyError,
    MortyProtocolError,
    MortyTimeoutError,
    MortyValidationError,
} from "./errors.ts";

export type { MortyCredentialProvider } from "./service-client.ts";

export type { MortyHttpTransport } from "./transport/http-transport.ts";

export { HttpTransport } from "./transport/http-transport.ts";

export type { MortyWebSocketConnector, WsTransportOptions } from "./transport/ws-transport.ts";

export { WsTransport } from "./transport/ws-transport.ts";

const APP_CREDENTIAL_PATTERN = /^mapp_[a-zA-Z0-9_-]{22}_[a-zA-Z0-9_-]{43}$/;

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new MortyProtocolError(`The Platform returned an invalid ${name}`);
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function string(value: Readonly<Record<string, unknown>>, field: string, maximum = 16_384): string {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length > maximum) {
        throw new MortyProtocolError(`The Platform returned an invalid ${field}`);
    }
    return candidate;
}

function identifier(value: Readonly<Record<string, unknown>>, field: string): Identifier {
    try {
        return decodeIdentifier(value[field]);
    } catch {
        throw new MortyProtocolError(`The Platform returned an invalid ${field}`);
    }
}

function timestamp(value: Readonly<Record<string, unknown>>, field: string): string {
    const candidate = string(value, field, 128);
    if (candidate.length > 0 && Number.isNaN(Date.parse(candidate))) {
        throw new MortyProtocolError(`The Platform returned an invalid ${field}`);
    }
    return candidate;
}

function requestedIdentifier(value: string, name: string): Identifier {
    if (!isIdentifier(value)) {
        throw new MortyValidationError(`The Platform ${name} is invalid`);
    }
    return value;
}

function requestedDisplayName(value: string): string {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 120) {
        throw new MortyValidationError("The Platform display name is invalid");
    }
    return normalized;
}

export class MortyAppCredentialProvider extends StaticMortyCredentialProvider {
    constructor(credential: string) {
        if (!APP_CREDENTIAL_PATTERN.test(credential)) {
            throw new MortyValidationError("The AppCredential is invalid");
        }
        super(credential);
    }
}

export class MortyPlatformProject {
    readonly appId: string;
    readonly clientReference: string;
    readonly createdAt: string;
    readonly deletedAt: string;
    readonly displayName: string;
    readonly lifecycle: string;
    readonly projectId: string;
    readonly tenantId: string;
    readonly updatedAt: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.appId = identifier(value, "appId");
        this.clientReference = identifier(value, "clientReference");
        this.createdAt = timestamp(value, "createdAt");
        this.deletedAt = timestamp(value, "deletedAt");
        this.displayName = string(value, "displayName", 120);
        this.lifecycle = string(value, "lifecycle", 32);
        this.projectId = identifier(value, "projectId");
        this.tenantId = identifier(value, "tenantId");
        this.updatedAt = timestamp(value, "updatedAt");
    }
}

export interface MortyCreatePlatformProjectRequest {
    readonly clientReference: string;
    readonly displayName: string;
    readonly idempotencyKey: string;
    readonly locationHint: ProjectLocationHint;
}

export class MortyPlatformAppClient {
    readonly #executor: MortyRequestExecutor;

    constructor(options: MortyEndpointOptions) {
        if (options.authenticationProviderId !== undefined) {
            throw new MortyValidationError("AppCredential requests cannot select a developer authentication provider");
        }
        this.#executor = new MortyRequestExecutor(options);
    }

    readonly createProject = async (
        appId: string,
        request: MortyCreatePlatformProjectRequest,
        signal: AbortSignal,
    ): Promise<MortyPlatformProject> =>
        new MortyPlatformProject(
            record(
                await this.#executor.post(
                    `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/projects`,
                    {
                        clientReference: requestedIdentifier(request.clientReference, "Project client reference"),
                        displayName: requestedDisplayName(request.displayName),
                        idempotencyKey: requestedIdentifier(request.idempotencyKey, "Project idempotency key"),
                        locationHint: requestedIdentifier(request.locationHint, "Location hint"),
                    },
                    signal,
                ),
                "Project",
            ),
        );
}

export { runtimeRequestTarget } from "./transport/runtime-request-target.ts";
