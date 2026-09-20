import { FakeClerk } from "@moxt-ai/mobius-test/clerk";
import { ManagedBotStorage } from "../../../src/components/management/storage/managed-bot-storage";
import { createSlackDependencies } from "../../../src/components/slack/composition/create-dependencies";
import { createSlackApplication } from "../../../src/components/slack/http";
import { createSlackFileHandler } from "../../../src/components/slack/http/bot-tools/slack-file-handler";
import type { SlackQueueMessage } from "../../../src/components/slack/infra/queue-message";
import { slackLogger } from "../../../src/components/slack/infra/util/logger";
import { SecretCipher } from "../../../src/components/slack/infra/util/secret-cipher";
import { ClockService } from "../../../src/components/slack/service/identity/clock-service";
import { DatabaseSlackAppDirectory } from "../../../src/components/slack/storage/database-slack-app-directory";
import { ClerkGateway } from "../../../src/gateway/clerk-gateway";
import { FakeAttachments, FakeIdentityGateway, FakeMobius, FakeSlack } from "./fake-environment";
import { createSignedRequest } from "./signed-request";
import { createTestDatabase } from "./test-database";

export async function createTestApplication() {
    const database = await createTestDatabase();
    const cipher = new SecretCipher(btoa("a".repeat(32)));
    const slack = new FakeSlack();
    const mobius = new FakeMobius();
    const identity = new FakeIdentityGateway();
    const attachments = new FakeAttachments();
    const pending: SlackQueueMessage[] = [];
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
    const fakeClerk = new FakeClerk({ issuer: "https://identity.clerk.accounts.dev" });
    const config = {
        authentication: {
            APP_ORIGIN: "https://slack.example.test",
            CLERK_JWT_KEY: fakeClerk.publicKey,
            CLERK_PUBLISHABLE_KEY: fakeClerk.publishableKey,
        },
        publicBaseUrl: "https://slack.example.test",
        projectId: `prj_ap_01_${"a".repeat(24)}`,
        mobiusBaseUrl: "https://mobius.test",
        signingKey: "state-signing-key",
    };
    const clerk = new ClerkGateway();
    const humanToken = async (userId = "tenant-1") =>
        fakeClerk.createSession(`user_${userId}`, config.authentication.APP_ORIGIN);
    const gateways = {
        queue,
        clerk,
        slackWebApi: slack,
        identityGateway: identity,
        botTriggerLimiter: limiter,
    };
    const utilities = {
        clock: new ClockService(),
        createNonce: () => "nonce-1",
        nowEpochMilliseconds: () => Date.now(),
        secretEncryption: cipher,
    };
    const storages = {
        databaseResolver: {
            resolve: () => database,
        },
        attachmentStorageResolver: attachments,
        humanIdentity: {
            resolve: async (clerkUserId: string, signal: AbortSignal) => {
                signal.throwIfAborted();
                return clerkUserId.startsWith("user_") ? clerkUserId.slice("user_".length) : clerkUserId;
            },
        },
    };
    const infrastructure = { config, gateways, logger: slackLogger, storages, utilities };
    const cx = createSlackDependencies({
        ...infrastructure,
        gateways: {
            ...gateways,
            platformProjects: mobius,
        },
        storages: {
            ...storages,
            slackAppDirectory: new DatabaseSlackAppDirectory(database, cipher),
        },
    });
    const signal = new AbortController().signal;
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
    const createChatBot = async (): Promise<void> => {
        // Chat owns this prerequisite; every Slack-owned transition below uses Slack HTTP.
        const bots = new ManagedBotStorage(database.binding);
        const now = Date.now();
        await bots.saveClaim("tenant-1", { botId: "chat-bot-1", displayName: "Test Chat Bot" }, now, signal);
        await bots.updateBot(
            "tenant-1",
            "chat-bot-1",
            { displayName: "Test Chat Bot", instructions: "Answer as the configured Chat Bot." },
            now,
            signal,
        );
        await bots.configureBot(
            "tenant-1",
            "chat-bot-1",
            {
                bindingId: "binding-1",
                runtimeId: "runtime-1",
                agentRef: "agent-1",
                workspaceRef: "workspace-1",
                agentConfigRevision: 1,
            },
            now,
            signal,
        );
    };
    const authorize = async (): Promise<Record<string, string>> => ({
        authorization: `Bearer ${await humanToken()}`,
        "Content-Type": "application/json",
    });
    const registerSlackApp = async (): Promise<string> => {
        const headers = await authorize();
        const registered = await request("/mobius-slack/api/slack/apps/register", {
            method: "POST",
            headers,
            body: JSON.stringify({
                slackBotId: "bot-1",
                name: "Test",
                clientId: "client-1",
                clientSecret: "client-secret",
                signingSecret: "signing-secret",
                slackAppId: "A123",
            }),
        });
        if (registered.status !== 201) {
            throw new Error(`Failed to register the test Slack app: ${registered.status}`);
        }
        const registration = (await registered.json()) as { readonly oauthAuthorizeUrl?: unknown };
        if (typeof registration.oauthAuthorizeUrl !== "string") {
            throw new Error("The test Slack app did not return an OAuth URL");
        }
        return registration.oauthAuthorizeUrl;
    };
    const connectSlackBot = async (): Promise<void> => {
        await createChatBot();
        const oauthAuthorizeUrl = await registerSlackApp();
        const headers = await authorize();
        const bound = await request("/mobius-slack/api/slack/bots/bot-1/binding", {
            method: "PUT",
            headers,
            body: JSON.stringify({ botId: "chat-bot-1" }),
        });
        if (bound.status !== 200) {
            throw new Error(`Failed to bind the test Slack app: ${bound.status}`);
        }
        const state = new URL(oauthAuthorizeUrl).searchParams.get("state");
        if (state === null) {
            throw new Error("The test Slack OAuth URL did not contain state");
        }
        const installed = await request(
            `/mobius-slack/api/slack/oauth/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
        );
        if (installed.status !== 302) {
            throw new Error(`Failed to install the test Slack app: ${installed.status}`);
        }
        slack.messages.length = 0;
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
        createChatBot,
        registerSlackApp,
        connectSlackBot,
    };
}

export async function createConnectedTestApplication() {
    const application = await createTestApplication();
    await application.connectSlackBot();
    return application;
}
