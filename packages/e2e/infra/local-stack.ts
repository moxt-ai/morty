import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonRequest, object, text } from "./chat-api.ts";
import type { E2EHarness } from "./harness.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const mobiusRepository = join(repository, "third-party", "mobius");
const fixtureDirectory = fileURLToPath(new URL("../fixtures", import.meta.url));
const platformConfiguration = join(fixtureDirectory, "wrangler.platform.jsonc");
const chatConfiguration = join(fixtureDirectory, "wrangler.chat.jsonc");
const wranglerExecutable = join(repository, "node_modules", ".bin", "wrangler");

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
        wranglerExecutable,
        ["d1", "migrations", "apply", binding, "--local", "--persist-to", persistence, "--config", configuration],
        { cwd },
    );
}

export class LocalStack {
    readonly harness: E2EHarness;
    readonly directories: Readonly<Record<"platform" | "chat" | "workspace", string>>;
    readonly platformOrigin: string;
    readonly chatOrigin: string;
    readonly platformPort: number;
    readonly chatPort: number;

    static async create(harness: E2EHarness) {
        const platformPort = await freePort();
        const chatPort = await freePort();
        const directories = {
            platform: join(harness.workDirectory, "platform"),
            chat: join(harness.workDirectory, "chat"),
            workspace: join(harness.workDirectory, "workspace"),
        };
        await Promise.all(Object.values(directories).map((path) => mkdir(path, { recursive: true })));
        return new LocalStack(harness, directories, platformPort, chatPort);
    }

    constructor(
        harness: E2EHarness,
        directories: Readonly<Record<"platform" | "chat" | "workspace", string>>,
        platformPort: number,
        chatPort: number,
    ) {
        this.harness = harness;
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
                "PLATFORM_DIRECTORY_DATABASE",
                this.directories.platform,
                mobiusRepository,
            );
        });
        await this.harness.stage("start-platform", async () => {
            await this.harness.startWorker(
                "mobius-platform",
                wranglerExecutable,
                [
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
            await this.harness.checkHttp(
                `${this.platformOrigin}/mobius/api/dashboard/health`,
                "mobius-platform health",
            );
        });
        return await this.harness.stage("provision-platform-application", async () => {
            const authentication = { provider: "e2e", token: "morty-local-e2e", signal: this.harness.signal };
            const inventory = await jsonRequest(
                this.platformOrigin,
                "/mobius/api/dashboard/v1/platform/tenants",
                authentication,
            );
            const tenant = object(Array.isArray(inventory["tenants"]) ? inventory["tenants"][0] : undefined, "tenant");
            const application = await jsonRequest(this.platformOrigin, "/mobius/api/dashboard/v1/apps", {
                ...authentication,
                body: {
                    displayName: "Morty live E2E",
                    tenantId: text(tenant["tenantId"], "tenantId"),
                },
            });
            return {
                appId: text(application["appId"], "appId"),
                appSecret: text(
                    object(application["defaultCredential"], "defaultCredential")["credential"],
                    "credential",
                ),
            };
        });
    }

    async startChat(application: { readonly appId: string; readonly appSecret: string }) {
        const variables = {
            APP_ORIGIN: this.chatOrigin,
            MOBIUS_APP_ID: application.appId,
            MOBIUS_APP_SECRET: application.appSecret,
            MOBIUS_BASE_URL: this.platformOrigin,
        };
        await this.harness.run(wranglerExecutable, [
            "r2",
            "object",
            "put",
            "morty-local-e2e-attachments/artifacts/setup.mjs",
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
            await this.harness.startWorker("morty", wranglerExecutable, [
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
            await this.harness.checkHttp(this.chatOrigin, "morty", (response) => response.status === 200);
        });
    }
}
