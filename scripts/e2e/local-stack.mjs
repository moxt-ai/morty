import { generateKeyPairSync } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonRequest, text } from "./chat-api.mjs";

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mobiusRepository = join(repository, "third-party", "mobius");
const fixtureDirectory = join(repository, "scripts", "e2e", "fixtures");
const platformConfiguration = join(fixtureDirectory, "wrangler.platform.jsonc");
const chatConfiguration = join(fixtureDirectory, "wrangler.chat.jsonc");
const acpProxy = fileURLToPath(new URL("./acp-proxy.mjs", import.meta.url));

async function freePort() {
    const server = createServer();
    await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Could not allocate a local port");
    }
    await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    return address.port;
}

async function migrate(harness, configuration, binding, persistence, cwd = repository) {
    await harness.run(
        "pnpm",
        [
            "exec",
            "wrangler",
            "d1",
            "migrations",
            "apply",
            binding,
            "--local",
            "--persist-to",
            persistence,
            "--config",
            configuration,
        ],
        { cwd },
    );
}

export class LocalStack {
    static async create(harness, openCode) {
        const platformPort = await freePort();
        const chatPort = await freePort();
        const directories = Object.fromEntries(
            ["platform", "chat", "runtime", "workspace", "xdg-cache", "xdg-data", "xdg-state"].map((name) => [
                name,
                join(harness.workDirectory, name),
            ]),
        );
        await Promise.all(Object.values(directories).map((path) => mkdir(path, { recursive: true })));
        return new LocalStack(harness, openCode, directories, platformPort, chatPort);
    }

    constructor(harness, openCode, directories, platformPort, chatPort) {
        this.harness = harness;
        this.openCode = openCode;
        this.directories = directories;
        this.platformOrigin = `http://127.0.0.1:${platformPort}`;
        this.chatOrigin = `http://127.0.0.1:${chatPort}`;
        this.platformPort = platformPort;
        this.chatPort = chatPort;
    }

    async startPlatform() {
        const revision = (
            await this.harness.run("git", ["rev-parse", "HEAD"], { cwd: mobiusRepository })
        ).stdout.trim();
        this.harness.record("mobiusRevision", revision);
        await this.harness.stage("build-mobius", () =>
            this.harness.run("pnpm", ["--filter", "@moxt-ai/mobius", "build"], { cwd: mobiusRepository }),
        );
        await this.harness.stage("migrate-platform", async () => {
            await migrate(
                this.harness,
                platformConfiguration,
                "D1_SHARD_APAC_01",
                this.directories.platform,
                mobiusRepository,
            );
            await migrate(
                this.harness,
                platformConfiguration,
                "PLATFORM_DIRECTORY_DATABASE",
                this.directories.platform,
                mobiusRepository,
            );
        });
        await this.harness.stage("start-platform", async () => {
            await this.harness.start(
                "mobius-platform",
                "pnpm",
                [
                    "exec",
                    "wrangler",
                    "dev",
                    "--config",
                    platformConfiguration,
                    "--ip",
                    "127.0.0.1",
                    "--port",
                    String(this.platformPort),
                    "--persist-to",
                    this.directories.platform,
                ],
                { cwd: mobiusRepository },
            );
            await this.harness.waitForHttp(`${this.platformOrigin}/mobius/api/health`, "mobius-platform health");
        });
        return await this.harness.stage("provision-platform-application", async () => {
            const authentication = { provider: "e2e", token: "mobius-chat-local-e2e", signal: this.harness.signal };
            const tenant = await jsonRequest(this.platformOrigin, "/mobius/api/v1/platform/tenants", {
                ...authentication,
                body: { displayName: "Mobius Chat live E2E" },
            });
            const application = await jsonRequest(this.platformOrigin, "/mobius/api/v1/apps", {
                ...authentication,
                body: { displayName: "Mobius Chat live E2E", tenantId: text(tenant.tenantId, "tenantId") },
            });
            return {
                appId: text(application.appId, "appId"),
                appSecret: text(application.defaultCredential?.credential, "credential"),
            };
        });
    }

    async startChat(application) {
        await this.harness.stage("migrate-chat", () =>
            migrate(this.harness, chatConfiguration, "CHAT_DATABASE_APAC", this.directories.chat),
        );
        const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const variables = {
            APP_ORIGIN: this.chatOrigin,
            AUTHENTICATION_BASE_URL: this.chatOrigin,
            CLERK_JWT_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
            CLERK_PUBLISHABLE_KEY: this.openCode.publishableKey,
            MOBIUS_APP_ID: application.appId,
            MOBIUS_APP_SECRET: application.appSecret,
            MOBIUS_BASE_URL: this.platformOrigin,
            SLACK_MOBIUS_AUTH_TOKEN: "unused-in-opencode-e2e",
            SLACK_OAUTH_STATE_SIGNING_KEY: "unused-in-opencode-e2e",
            SLACK_SERVER_BASE_URL: this.chatOrigin,
            SLACK_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
            VITE_MOBIUS_APP_ID: application.appId,
            VITE_MOBIUS_BASE_URL: this.platformOrigin,
        };
        await this.harness.stage("build-chat", () =>
            this.harness.run("pnpm", ["build", "--mode", "e2e"], { env: variables }),
        );
        await this.harness.stage("start-chat", async () => {
            const variableArguments = Object.entries(variables).flatMap(([key, value]) => ["--var", `${key}:${value}`]);
            await this.harness.start("mobius-chat", "pnpm", [
                "exec",
                "wrangler",
                "dev",
                "--config",
                chatConfiguration,
                "--ip",
                "127.0.0.1",
                "--port",
                String(this.chatPort),
                "--persist-to",
                this.directories.chat,
                ...variableArguments,
            ]);
            await this.harness.waitForHttp(this.chatOrigin, "mobius-chat", (response) => response.status === 200);
        });
    }

    async startMobius(pairing) {
        return await this.harness.start(
            "mobius",
            process.execPath,
            [
                join(mobiusRepository, "packages", "cli", "dist", "cli.js"),
                "pair",
                "--url",
                text(pairing.relayUrl, "relayUrl"),
                "--pairing",
                text(pairing.pairingId, "pairingId"),
                "--code",
                text(pairing.pairingCode, "pairingCode"),
                "--workspace",
                this.directories.workspace,
            ],
            {
                env: {
                    MOBIUS_E2E_ACP_TRACE_DIRECTORY: join(this.harness.artifactDirectory, "acp"),
                    MOBIUS_E2E_OPENCODE_REAL_BIN: this.openCode.binary,
                    MOBIUS_OPENCODE_PATH: acpProxy,
                    MOBIUS_STATE_DIRECTORY: this.directories.runtime,
                    OPENCODE_DISABLE_AUTOUPDATE: "1",
                    XDG_CACHE_HOME: this.directories["xdg-cache"],
                    XDG_CONFIG_HOME: this.openCode.xdgConfigHome,
                    XDG_DATA_HOME: this.directories["xdg-data"],
                    XDG_STATE_HOME: this.directories["xdg-state"],
                },
            },
        );
    }
}
