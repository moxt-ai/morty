import {
    MobiusApiError,
    MobiusCancellationError,
    MobiusPlatformDeveloperClient,
    MobiusTimeoutError,
} from "@moxt-ai/mobius-sdk/platform";
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

    readonly create = async (userId: string, displayName: string, token: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const configuration = this.configuration();
        let placement: { readonly d1ShardId: string; readonly r2BucketId: string };
        try {
            placement = {
                d1ShardId: v.parse(platformIdentifier, this.#bindings.MOBIUS_PROJECT_D1_SHARD_ID),
                r2BucketId: v.parse(platformIdentifier, this.#bindings.MOBIUS_PROJECT_R2_BUCKET_ID),
            };
        } catch (cause) {
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Project placement is not configured.", 503, {
                cause,
            });
        }
        const client = new MobiusPlatformDeveloperClient({
            endpoint: configuration.origin,
            authenticationProviderId: "clerk",
            credentialProvider: {
                credential: async (credentialSignal) => {
                    credentialSignal.throwIfAborted();
                    return token;
                },
            },
            operationTimeoutMilliseconds: 15000,
        });
        try {
            const project = await client.createProject(
                configuration.appId,
                {
                    clientReference: userId,
                    idempotencyKey: `cloud-${userId}`,
                    displayName,
                    placement,
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
                    "PLATFORM_DEVELOPER_REQUIRED",
                    "A valid Platform developer token and Tenant membership are required.",
                    403,
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
