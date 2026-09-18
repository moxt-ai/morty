import { createSlackDependencies } from "../../../src/components/slack/composition/create-dependencies";
import { createSlackApplication } from "../../../src/components/slack/http";
import { createSlackFileHandler } from "../../../src/components/slack/http/bot-tools/slack-file-handler";
import type { SlackQueueMessage } from "../../../src/components/slack/infra/queue-message";
import { slackLogger } from "../../../src/components/slack/infra/util/logger";
import { SecretCipher } from "../../../src/components/slack/infra/util/secret-cipher";
import { ClockService } from "../../../src/components/slack/service/identity/clock-service";
import { tenantContext } from "../../../src/components/slack/service/identity/tenant-context";
import { DatabaseSlackAppDirectory } from "../../../src/components/slack/storage/database-slack-app-directory";
import { managedBot } from "../../../src/schema/index.ts";
import { InMemoryAttachments } from "./in-memory-attachments";
import { InMemoryClerkGateway } from "./in-memory-clerk-gateway";
import { InMemoryIdentityGateway } from "./in-memory-identity-gateway";
import { InMemoryMobius } from "./in-memory-mobius-gateway";
import { InMemorySlack } from "./in-memory-slack-gateway";
import { createSignedRequest } from "./signed-request";
import { createTestDatabase } from "./test-database";

export async function createTestApplication(_singleDatabase = false) {
    const database = await createTestDatabase();
    const cipher = new SecretCipher(btoa("a".repeat(32)));
    const slack = new InMemorySlack();
    const mobius = new InMemoryMobius();
    const identity = new InMemoryIdentityGateway();
    const attachments = new InMemoryAttachments();
    const pending: SlackQueueMessage[] = [];
    const clerk = new InMemoryClerkGateway();
    const { humanToken } = clerk;
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
        authentication: {
            APP_ORIGIN: "https://slack.example.test",
            CLERK_JWT_KEY: "test-jwt-key",
            CLERK_PUBLISHABLE_KEY: "test-publishable-key",
        },
        publicBaseUrl: "https://slack.example.test",
        projectId: `prj_ap_01_${"a".repeat(24)}`,
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
        clerk,
        slackWebApi: slack,
        identityGateway: identity,
        humanIdentity: {
            resolve: async (clerkUserId: string, signal: AbortSignal) => {
                signal.throwIfAborted();
                return clerkUserId;
            },
        },
        botTriggerLimiter: limiter,
        slackAppDatabase: database,
    };
    const infrastructure = { config, gateways, logger: slackLogger };
    const cx = createSlackDependencies({
        ...infrastructure,
        gateways: {
            ...gateways,
            platformProjects: mobius,
            slackAppDirectory: new DatabaseSlackAppDirectory(infrastructure),
        },
    });
    const storage = cx.storages.slackEventStorage;
    const signal = new AbortController().signal;
    const tenant = tenantContext("tenant-1");
    const connections = cx.storages.chatBotBindingStorage;
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
    await database.execute(
        "run",
        1,
        signal,
        async (orm) =>
            await orm.insert(managedBot).values({
                userId: "tenant-1",
                botId: "chat-bot-1",
                displayName: "Test Chat Bot",
                bindingId: "binding-1",
                runtimeId: "runtime-1",
                agentRef: "agent-1",
                workspaceRef: "workspace-1",
                agentConfigRevision: 1,
                instructions: "Answer as the configured Chat Bot.",
                legacyMigrationPending: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }),
    );
    await connections.saveBinding(
        tenant,
        {
            tenantId: "tenant-1",
            slackBotId: "bot-1",
            botId: "chat-bot-1",
            connectionId: "connection-1",
            projectId: config.projectId,
            bindingId: "binding-1",
            runtimeId: "runtime-1",
            agentRef: "agent-1",
            workspaceRef: "workspace-1",
            agentConfigRevision: 1,
            instructions: "Answer as the configured Chat Bot.",
        },
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
