import {
    createPlatformWorker,
    PlatformAuthenticationConfiguration,
} from "../../../third-party/mobius/packages/relay-cloudflare-platform/src/worker.ts";
import {
    ProjectAuthenticationError,
    VerifiedExternalIdentity,
} from "../../../third-party/mobius/packages/relay-core/src/index.ts";

const E2E_DEVELOPER_SUBJECT = "mobius-chat-e2e";

const authenticator = {
    authenticate: async (
        credential: { readonly providerId: string; readonly credential: string },
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        if (credential.providerId !== "e2e" || credential.credential !== "mobius-chat-local-e2e") {
            throw new ProjectAuthenticationError("external_identity_invalid", "The local E2E identity is invalid");
        }
        return new VerifiedExternalIdentity(
            "clerk",
            "https://mobius-chat-e2e.invalid",
            E2E_DEVELOPER_SUBJECT,
            new Map(),
            Date.now(),
            Date.now() + 60 * 60 * 1_000,
            { kind: "organization", id: "org_mobiuschate2e", role: "org:admin" },
        );
    },
};

export default createPlatformWorker(
    new PlatformAuthenticationConfiguration(authenticator, new Set([E2E_DEVELOPER_SUBJECT]), new Set(["*"])),
);

export {
    BotConnectionActor,
    PlatformSessionRelay,
    RuntimeRelay,
} from "../../../third-party/mobius/packages/relay-cloudflare-platform/src/durable-objects.ts";
