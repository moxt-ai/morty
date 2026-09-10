import { createSlackApplication } from "../../../packages/worker/src/components/slack/app";
import { createSlackDependencies } from "../../../packages/worker/src/components/slack/create-dependencies";
import { createSlackFileHandler } from "../../../packages/worker/src/components/slack/http/bot-tools/slack-file-handler";
import { slackLogger } from "../../../packages/worker/src/components/slack/infra/logger";
import type { SlackQueueMessage } from "../../../packages/worker/src/components/slack/infra/queue-message";
import { SecretCipher } from "../../../packages/worker/src/components/slack/infra/secret-cipher";
import { ClockService } from "../../../packages/worker/src/components/slack/service/identity/clock-service";
import { tenantContext } from "../../../packages/worker/src/components/slack/service/identity/tenant-context";
import { DatabaseSlackAppDirectory } from "../../../packages/worker/src/components/slack/storage/database-slack-app-directory";
import { MobiusGateway } from "../../../packages/worker/src/gateway/index";
import { InMemoryAttachments } from "./in-memory-attachments";
import { InMemoryHumanIdentity } from "./in-memory-human-identity";
import { InMemoryIdentityGateway } from "./in-memory-identity-gateway";
import { InMemoryMobius } from "./in-memory-mobius-gateway";
import { InMemorySlack } from "./in-memory-slack-gateway";
import { createSignedRequest } from "./signed-request";
import { createTestDatabase } from "./test-database";

export async function createTestApplication(
    _singleDatabase = false,
    createMobiusGateway: (cx: ConstructorParameters<typeof MobiusGateway>[0]) => MobiusGateway = (cx) =>
        new MobiusGateway(cx),
) {
    const database = createTestDatabase();
    const cipher = new SecretCipher(btoa("a".repeat(32)));
    const slack = new InMemorySlack();
    const mobius = new InMemoryMobius();
    const identity = new InMemoryIdentityGateway();
    const attachments = new InMemoryAttachments();
    const pending: SlackQueueMessage[] = [];
    const humanIdentity = new InMemoryHumanIdentity();
    const { humanToken } = humanIdentity;
    const limiter = {
        mode: "admit",
        admit: async (): Promise<boolean> => {
            if (limiter.mode === "fail") {
                throw new Error("Unavailable");
            }
            return limiter.mode === "admit";
        },
    };
    const queue = {
        send: async (message: SlackQueueMessage): Promise<void> => {
            pending.push(message);
        },
    };
    const config = {
        publicBaseUrl: "https://slack.example.test",
        mobiusBaseUrl: "https://mobius.test",
        signingKey: "state-signing-key",
    };
    const gateways = {
        clock: new ClockService(),
        createNonce: () => "nonce-1",
        nowEpochMilliseconds: () => Date.now(),
        secretEncryption: cipher,
        queue,
        databaseResolver: {
            resolve: () => database,
        },
        attachmentStorageResolver: attachments,
        mobiusFetchGateway: mobius,
        slackWebApi: slack,
        identityGateway: identity,
        botTriggerLimiter: limiter,
        slackAppDatabase: database,
    };
    const infrastructure = { config, gateways, logger: slackLogger };
    const cx = createSlackDependencies({
        ...infrastructure,
        gateways: {
            ...gateways,
            humanIdentity,
            mobius: createMobiusGateway(infrastructure),
            slackAppDirectory: new DatabaseSlackAppDirectory(infrastructure),
        },
    });
    const storage = cx.storages.slackEventStorage;
    const signal = new AbortController().signal;
    const tenant = tenantContext("tenant-1");
    const connections = cx.storages.mobiusConnectionStorage;
    await storage.registerApp(
        tenant,
        {
            botId: "bot-1",
            appName: "Test",
            clientId: "client-1",
            clientSecretEncrypted: await cipher.encrypt("client-secret", signal),
            oauthRedirectUri: "https://slack.example.test/mobius-slack/api/slack/oauth/callback",
            signingSecretEncrypted: await cipher.encrypt("signing-secret", signal),
            slackAppId: "A123",
            tenantId: "tenant-1",
            timestamp: Date.now(),
        },
        signal,
    );
    await connections.saveBinding(
        tenant,
        await cx.gateways.mobius.connectBot("tenant-1", "bot-1", mobius.ownBot("mobius-bot-1"), signal),
        signal,
    );
    await storage.upsertInstallation(
        tenant,
        {
            botTokenEncrypted: await cipher.encrypt("xoxb-token", signal),
            installedAt: Date.now(),
            slackAppRecordId: 1,
            slackBotUserId: "U_BOT",
            slackTeamId: "T123",
            slackTeamName: "Example",
            tenantId: "tenant-1",
        },
        signal,
    );
    const application = createSlackApplication();
    const fetchFile = createSlackFileHandler(cx.services.slackFiles);
    const consumer = cx.services.queueConsumer;
    const queueErrors: unknown[] = [];
    const request = async (url: string, init?: RequestInit): Promise<Response> => {
        const response = url.startsWith("/mobius-slack/api/files/")
            ? await fetchFile(new Request(new URL(url, "https://slack.example.test"), init))
            : await application.request(url, init, cx);
        while (pending.length > 0) {
            const message = pending.shift();
            if (message === undefined) {
                break;
            }
            try {
                await consumer.consume(message, init?.signal ?? signal);
            } catch (error) {
                queueErrors.push(error);
            }
        }
        return response;
    };
    return {
        database,
        request,
        signedRequest: createSignedRequest(request),
        humanToken,
        slack,
        mobius,
        identity,
        limiter,
        attachments,
        queueErrors,
    };
}
