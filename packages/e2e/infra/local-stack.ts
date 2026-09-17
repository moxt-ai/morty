import { generateKeyPairSync } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SetupRuntime } from "../../setup/src/setup.ts";
import { jsonRequest, object, text } from "./chat-api.ts";
import type { E2EHarness } from "./harness.ts";

interface AgentConfiguration {
    readonly acpBinary: string;
    readonly adapterOverrideVariable: string;
    readonly description: string;
    readonly id: string;
    readonly label: string;
    readonly publishableKey: string;
    readonly runtimeEnvironment: Readonly<Record<string, string>>;
}

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const mobiusRepository = join(repository, "third-party", "mobius");
const fixtureDirectory = fileURLToPath(new URL("../fixtures", import.meta.url));
const platformConfiguration = join(fixtureDirectory, "wrangler.platform.jsonc");
const chatConfiguration = join(fixtureDirectory, "wrangler.chat.jsonc");
const acpProxy = fileURLToPath(new URL("./acp-proxy.ts", import.meta.url));

async function freePort() {
    const server = createServer();
    await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Could not allocate a local port");
    }
    await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
    );
    return address.port;
}

async function migrate(
    harness: E2EHarness,
    configuration: string,
    binding: string,
    persistence: string,
    cwd = repository,
) {
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
    readonly harness: E2EHarness;
    readonly agent: AgentConfiguration;
    readonly directories: Readonly<Record<string, string>>;
    readonly platformOrigin: string;
    readonly chatOrigin: string;
    readonly platformPort: number;
    readonly chatPort: number;

    static async create(harness: E2EHarness, agent: AgentConfiguration) {
        const platformPort = await freePort();
        const chatPort = await freePort();
        const directories = Object.fromEntries(
            ["platform", "chat", "runtime", "workspace", "xdg-cache", "xdg-config", "xdg-data", "xdg-state"].map(
                (name) => [name, join(harness.workDirectory, name)],
            ),
        );
        await Promise.all(Object.values(directories).map((path) => mkdir(path, { recursive: true })));
        return new LocalStack(harness, agent, directories, platformPort, chatPort);
    }

    constructor(
        harness: E2EHarness,
        agent: AgentConfiguration,
        directories: Readonly<Record<string, string>>,
        platformPort: number,
        chatPort: number,
    ) {
        this.harness = harness;
        this.agent = agent;
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
        await this.harness.stage("migrate-platform", async () => {
            await migrate(
                this.harness,
                platformConfiguration,
                "D1_SHARD_WNAM_01",
                this.directories.platform,
                mobiusRepository,
            );
            await migrate(
                this.harness,
                platformConfiguration,
                "D1_SHARD_APAC_01",
                this.directories.platform,
                mobiusRepository,
            );
            const shardingConfiguration = join(this.directories.platform, "sharding-migrations.json");
            await this.harness.run(
                "node",
                [
                    "packages/relay-cloudflare-platform/scripts/sharding-migrations.ts",
                    "--config",
                    platformConfiguration,
                    "--output",
                    shardingConfiguration,
                ],
                { cwd: mobiusRepository },
            );
            for (const binding of ["D1_SHARD_WNAM_01", "D1_SHARD_APAC_01"]) {
                await migrate(
                    this.harness,
                    shardingConfiguration,
                    binding,
                    this.directories.platform,
                    mobiusRepository,
                );
            }
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
                    "--inspector-port",
                    "0",
                    "--persist-to",
                    this.directories.platform,
                ],
                { cwd: mobiusRepository },
            );
            await this.harness.waitForHttp(`${this.platformOrigin}/mobius/api/health`, "mobius-platform health");
        });
        return await this.harness.stage("provision-platform-application", async () => {
            const authentication = { provider: "e2e", token: "mobius-chat-local-e2e", signal: this.harness.signal };
            const inventory = await jsonRequest(this.platformOrigin, "/mobius/api/v1/platform/tenants", authentication);
            const tenant = object(Array.isArray(inventory.tenants) ? inventory.tenants[0] : undefined, "tenant");
            const application = await jsonRequest(this.platformOrigin, "/mobius/api/v1/apps", {
                ...authentication,
                body: { displayName: "Mobius Chat live E2E", tenantId: text(tenant.tenantId, "tenantId") },
            });
            return {
                appId: text(application.appId, "appId"),
                appSecret: text(object(application.defaultCredential, "defaultCredential").credential, "credential"),
            };
        });
    }

    async startChat(application: { readonly appId: string; readonly appSecret: string }) {
        await migrate(this.harness, chatConfiguration, "CHAT_DATABASE_WNAM", this.directories.chat);
        await this.harness.stage("migrate-chat", () =>
            migrate(this.harness, chatConfiguration, "CHAT_DATABASE_APAC", this.directories.chat),
        );
        const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const variables = {
            APP_ORIGIN: this.chatOrigin,
            AUTHENTICATION_BASE_URL: this.chatOrigin,
            CLERK_JWT_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
            CLERK_PUBLISHABLE_KEY: this.agent.publishableKey,
            MOBIUS_APP_ID: application.appId,
            MOBIUS_APP_SECRET: application.appSecret,
            MOBIUS_BASE_URL: this.platformOrigin,
            SLACK_MOBIUS_AUTH_TOKEN: "unused-in-agent-image-e2e",
            SLACK_OAUTH_STATE_SIGNING_KEY: "unused-in-agent-image-e2e",
            SLACK_SERVER_BASE_URL: this.chatOrigin,
            SLACK_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        };
        await this.harness.run("pnpm", [
            "exec",
            "wrangler",
            "r2",
            "object",
            "put",
            "mobius-chat-local-e2e-attachments/artifacts/setup.mjs",
            "--file",
            join(repository, "packages/setup/dist/setup.mjs"),
            "--local",
            "--persist-to",
            this.directories.chat,
            "--config",
            chatConfiguration,
        ]);
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
                "--inspector-port",
                "0",
                "--persist-to",
                this.directories.chat,
                ...variableArguments,
            ]);
            await this.harness.waitForHttp(this.chatOrigin, "mobius-chat", (response) => response.status === 200);
        });
    }

    async startMobius(pairing: Readonly<Record<string, unknown>>) {
        return await this.startRuntime([
            "pair",
            "--url",
            text(pairing.relayUrl, "relayUrl"),
            "--pairing",
            text(pairing.pairingId, "pairingId"),
            "--code",
            text(pairing.pairingCode, "pairingCode"),
        ]);
    }

    setupRuntime(): SetupRuntime {
        return {
            start: async (_directory, args, signal) => {
                signal.throwIfAborted();
                const child = await this.startRuntime(args);
                if (child.pid === undefined) {
                    throw new Error("Runtime process did not start");
                }
                return { pid: child.pid, logPath: join(this.harness.artifactDirectory, "mobius.log") };
            },
        };
    }

    async startRuntime(args: readonly string[]) {
        return await this.harness.start(
            "mobius",
            process.execPath,
            [
                join(mobiusRepository, "packages", "cli", "dist", "cli.js"),
                ...args,
                "--workspace",
                this.directories.workspace,
            ],
            {
                env: {
                    MOBIUS_E2E_ACP_TRACE_DIRECTORY: join(this.harness.artifactDirectory, "acp"),
                    MOBIUS_E2E_ACP_REAL_BIN: this.agent.acpBinary,
                    [this.agent.adapterOverrideVariable]: acpProxy,
                    MOBIUS_STATE_DIRECTORY: this.directories.runtime,
                    XDG_CACHE_HOME: this.directories["xdg-cache"],
                    XDG_CONFIG_HOME: this.directories["xdg-config"],
                    XDG_DATA_HOME: this.directories["xdg-data"],
                    XDG_STATE_HOME: this.directories["xdg-state"],
                    ...this.agent.runtimeEnvironment,
                },
            },
        );
    }
}
