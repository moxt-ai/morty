import type { BotTriggerLimiter } from "../../../gateway/bot-trigger-limiter";
import type { ClerkGateway } from "../../../gateway/clerk-gateway.ts";
import type { IdentityGateway } from "../../../gateway/identity-gateway";
import type { SlackWebApi } from "../../../gateway/slack-web-gateway";
import type { AuthenticationConfiguration } from "../../management/storage/authentication-configuration.ts";
import type { SlackPlatformGateway } from "../entity/slack-platform-gateway.ts";
import type { DatabaseResolver } from "../infra/database-resolver";
import type { SlackQueue } from "../infra/slack-queue";
import type { SlackLogger } from "../infra/util/logger";
import type { SecretCipher } from "../infra/util/secret-cipher";
import type { ClockService } from "../service/identity/clock-service";
import type { AttachmentStorageResolver } from "../storage/attachment-storage-resolver";
import type { SlackAppDirectory } from "../storage/slack-app-directory";

export interface HumanIdentityResolver {
    readonly resolve: (clerkUserId: string, signal: AbortSignal) => Promise<string>;
}

interface SlackGateways {
    readonly clerk: ClerkGateway;
    readonly platformProjects: SlackPlatformGateway;
    readonly identityGateway: IdentityGateway;
    readonly slackWebApi: SlackWebApi;
    readonly botTriggerLimiter: BotTriggerLimiter;
    readonly queue: SlackQueue;
}

interface SlackStorages {
    readonly databaseResolver: DatabaseResolver;
    readonly attachmentStorageResolver: AttachmentStorageResolver;
    readonly slackAppDirectory: SlackAppDirectory;
    readonly humanIdentity: HumanIdentityResolver;
}

interface SlackUtilities {
    readonly clock: ClockService;
    readonly createNonce: () => string;
    readonly nowEpochMilliseconds: () => number;
    readonly secretEncryption: SecretCipher;
}

interface SlackConfig {
    readonly authentication: AuthenticationConfiguration;
    readonly publicBaseUrl: string;
    readonly projectId: string;
    readonly mobiusBaseUrl: string;
    readonly signingKey: string;
}

/** Configuration and adapters supplied by the host for the current request. */
export interface SlackInfrastructure {
    readonly config: SlackConfig;
    readonly gateways: SlackGateways;
    readonly logger: SlackLogger;
    readonly storages: SlackStorages;
    readonly utilities: SlackUtilities;
}
