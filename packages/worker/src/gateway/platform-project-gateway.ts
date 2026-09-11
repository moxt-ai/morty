import {
    MobiusApiError,
    MobiusAppCredentialProvider,
    MobiusCancellationError,
    MobiusPlatformAppClient,
    MobiusTimeoutError,
} from "@moxt-ai/mobius-sdk/platform";
import { MobiusBotOwnerClient, MobiusClient, MobiusRuntimePairingRequest } from "@moxt-ai/mobius-sdk/server";
import * as v from "valibot";
import {
    PlatformProjectError,
    platformIdentifier,
    platformProjectSchema,
} from "../components/management/entity/platform-project.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";

export class PlatformProjectGateway {
    readonly #bindings: CloudBindings;
    constructor(bindings: CloudBindings) {
        this.#bindings = bindings;
    }

    readonly configuration = () => {
        try {
            const endpoint = new URL(v.parse(v.string(), this.#bindings.MOBIUS_BASE_URL));
            if (
                (endpoint.protocol !== "https:" &&
                    !(
                        endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
                    )) ||
                endpoint.username !== "" ||
                endpoint.password !== "" ||
                endpoint.pathname !== "/" ||
                endpoint.search !== "" ||
                endpoint.hash !== "" ||
                (typeof this.#bindings.APP_ORIGIN === "string" &&
                    endpoint.origin === new URL(this.#bindings.APP_ORIGIN).origin)
            ) {
                throw new Error("Invalid Platform endpoint");
            }
            return { origin: endpoint.origin, appId: v.parse(platformIdentifier, this.#bindings.MOBIUS_APP_ID) };
        } catch (cause) {
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Platform is not configured.", 503, { cause });
        }
    };

    readonly createPairing = async (projectId: string, idempotencyKey: string, signal: AbortSignal) =>
        await this.#withProject(projectId, signal, async (client) => {
            const pairing = await client.runtimePairings.create(
                new MobiusRuntimePairingRequest(idempotencyKey),
                signal,
            );
            if (pairing.projectId !== projectId) {
                throw new PlatformProjectError(
                    "PLATFORM_INVALID_RESPONSE",
                    "Platform returned an unexpected pairing.",
                    502,
                );
            }
            return { ...pairing, relayUrl: this.configuration().origin };
        });

    readonly createBot = async (projectId: string, signal: AbortSignal) => {
        const client = new MobiusBotOwnerClient({
            endpoint: this.configuration().origin,
            projectId,
            credentialProvider: new MobiusAppCredentialProvider(v.parse(v.string(), this.#bindings.MOBIUS_APP_SECRET)),
            operationTimeoutMilliseconds: 15000,
        });
        try {
            const bot = await client.createBot({ displayName: "My Bot", description: "", avatarRef: "" }, signal);
            if (bot.projectId !== projectId) {
                throw new PlatformProjectError("PLATFORM_INVALID_RESPONSE", "The Bot could not be verified.", 502);
            }
            return { botId: bot.botId, displayName: bot.displayName };
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof MobiusCancellationError || cause instanceof PlatformProjectError) {
                throw cause;
            }
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Your Bot could not be created.", 502, { cause });
        }
    };

    readonly readPairing = async (projectId: string, pairingId: string, signal: AbortSignal) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => await client.runtimePairings.read(pairingId, signal),
        );

    readonly #withProject = async <T>(
        projectId: string,
        signal: AbortSignal,
        operation: (client: MobiusClient) => Promise<T>,
    ): Promise<T> => {
        signal.throwIfAborted();
        const client = new MobiusClient({
            endpoint: this.configuration().origin,
            projectId: v.parse(platformIdentifier, projectId),
            credentialProvider: new MobiusAppCredentialProvider(v.parse(v.string(), this.#bindings.MOBIUS_APP_SECRET)),
            operationTimeoutMilliseconds: 15000,
        });
        try {
            return await operation(client);
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof MobiusCancellationError || cause instanceof PlatformProjectError) {
                throw cause;
            }
            if (cause instanceof MobiusTimeoutError) {
                throw new PlatformProjectError("PLATFORM_TIMEOUT", "Platform did not respond in time.", 504, { cause });
            }
            if (cause instanceof MobiusApiError && cause.status === 404) {
                throw new PlatformProjectError("NOT_FOUND", "The Runtime pairing was not found.", 404, { cause });
            }
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Platform could not complete Runtime setup.", 502, {
                cause,
            });
        } finally {
            client.close();
        }
    };

    readonly create = async (userId: string, displayName: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const configuration = this.configuration();
        let locationHint: string;
        try {
            locationHint = v.parse(platformIdentifier, this.#bindings.MOBIUS_PROJECT_LOCATION_HINT);
        } catch (cause) {
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Project placement is not configured.", 503, {
                cause,
            });
        }
        const client = new MobiusPlatformAppClient({
            endpoint: configuration.origin,
            credentialProvider: new MobiusAppCredentialProvider(v.parse(v.string(), this.#bindings.MOBIUS_APP_SECRET)),
            operationTimeoutMilliseconds: 15000,
        });
        try {
            const project = await client.createProject(
                configuration.appId,
                {
                    clientReference: userId,
                    idempotencyKey: `cloud-${userId}`,
                    displayName,
                    locationHint,
                },
                signal,
            );
            if (
                project.appId !== configuration.appId ||
                project.clientReference !== userId ||
                project.lifecycle !== "active"
            ) {
                throw new PlatformProjectError(
                    "PLATFORM_INVALID_RESPONSE",
                    "Platform returned an unexpected Project.",
                    502,
                );
            }
            return v.parse(platformProjectSchema, project);
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof MobiusCancellationError || cause instanceof PlatformProjectError) {
                throw cause;
            }
            if (cause instanceof MobiusTimeoutError) {
                throw new PlatformProjectError("PLATFORM_TIMEOUT", "Platform did not respond in time.", 504, { cause });
            }
            if (cause instanceof MobiusApiError && (cause.status === 401 || cause.status === 403)) {
                throw new PlatformProjectError(
                    "PLATFORM_APP_UNAUTHORIZED",
                    "The Chat App is not authorized to provision Projects.",
                    502,
                    { cause },
                );
            }
            if (cause instanceof MobiusApiError && cause.status === 409) {
                throw new PlatformProjectError(
                    "PLATFORM_PROJECT_CONFLICT",
                    "Project provisioning conflicts with an earlier request.",
                    409,
                    { cause },
                );
            }
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Platform could not provision the Project.", 502, {
                cause,
            });
        }
    };
}
