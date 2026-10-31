import {
    type ConfiguredPlatformRelayBindings,
    createPlatformApplication,
    createPlatformGateways,
    createPlatformWorker,
    PlatformAuthenticationConfiguration,
} from "../../../third-party/mobius/packages/relay-cloudflare-platform/src/worker.ts";
import {
    ProjectAuthenticationError,
    VerifiedExternalIdentity,
} from "../../../third-party/mobius/packages/relay-core/src/index.ts";

const E2E_DEVELOPER_SUBJECT = "morty-e2e";

const authenticator = {
    authenticate: async (
        credential: { readonly providerId: string; readonly credential: string },
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        if (credential.providerId !== "e2e" || credential.credential !== "morty-local-e2e") {
            throw new ProjectAuthenticationError("external_identity_invalid", "The local E2E identity is invalid");
        }
        return new VerifiedExternalIdentity(
            "clerk",
            "https://morty-e2e.invalid",
            E2E_DEVELOPER_SUBJECT,
            new Map(),
            Date.now(),
            Date.now() + 60 * 60 * 1_000,
            { kind: "organization", id: "org_mortye2e", role: "org:admin" },
        );
    },
};

const worker = createPlatformApplication(
    new PlatformAuthenticationConfiguration(authenticator, new Set([E2E_DEVELOPER_SUBJECT]), new Set(["*"])),
    createPlatformGateways,
);

const transport = createPlatformWorker();

export default {
    fetch: (request: Request, environment: ConfiguredPlatformRelayBindings) =>
        request.headers.get("Upgrade")?.toLowerCase() === "websocket"
            ? transport.fetch(request, environment)
            : worker.fetch(request, environment),
};

export {
    ProjectDO,
    RuntimeRelay,
} from "../../../third-party/mobius/packages/relay-cloudflare-platform/src/worker.ts";
