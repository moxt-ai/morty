import type { BotTriggerLimiter } from "../../gateway/bot-trigger-limiter";
import type { HumanIdentity } from "../../gateway/human-identity";
import type { IdentityGateway } from "../../gateway/identity-gateway";
import type { MobiusGateway } from "../../gateway/mobius-gateway";
import type { SlackWebApi } from "../../gateway/slack-web-gateway";
import type { DatabaseResolver } from "./infra/database-resolver";
import type { SlackLogger } from "./infra/logger";
import type { SecretCipher } from "./infra/secret-cipher";
import type { SlackQueue } from "./infra/slack-queue";
import type { ClockService } from "./service/identity/clock-service";
import type { AttachmentStorageResolver } from "./storage/attachment-storage-resolver";
import type { SlackAppDirectory } from "./storage/slack-app-directory";

interface SlackGateways {
    readonly humanIdentity: HumanIdentity;
    readonly mobius: MobiusGateway;
    readonly identityGateway: IdentityGateway;
    readonly slackWebApi: SlackWebApi;
    readonly botTriggerLimiter: BotTriggerLimiter;
    readonly clock: ClockService;
    readonly createNonce: () => string;
    readonly nowEpochMilliseconds: () => number;
    readonly secretEncryption: SecretCipher;
    readonly queue: SlackQueue;
    readonly databaseResolver: DatabaseResolver;
    readonly attachmentStorageResolver: AttachmentStorageResolver;
    readonly slackAppDirectory: SlackAppDirectory;
}

interface SlackConfig {
    readonly publicBaseUrl: string;
    readonly mobiusBaseUrl: string;
    readonly signingKey: string;
}

/** Configuration and adapters supplied by the host for the current request. */
export interface SlackInfrastructure {
    readonly config: SlackConfig;
    readonly gateways: SlackGateways;
    readonly logger: SlackLogger;
}
