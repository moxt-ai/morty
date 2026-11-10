import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { provisionLocalService } from "../../../scripts/provision-local-service.ts";
import type { E2EHarness } from "./harness.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const mortyRepository = repository;
const fixtureDirectory = fileURLToPath(new URL("../fixtures", import.meta.url));
const relayConfiguration = join(fixtureDirectory, "wrangler.relay.jsonc");
const chatConfiguration = join(fixtureDirectory, "wrangler.chat.jsonc");
const wranglerExecutable = join(repository, "node_modules", ".bin", "wrangler");

// The Workers learn each other's origins before either starts, so the stack chooses their ports instead of binding
// port 0. It chooses below every relay's ephemeral range (Linux from 32768, macOS and Windows from 49152): a port
// the system assigns to any other socket meanwhile, an outbound connection or a Worker's inspector, cannot take it.
const STACK_PORTS = { first: 20_000, last: 32_767 } as const;

async function bindable(port: number): Promise<boolean> {
    const server = createServer();
    const listening = await new Promise<boolean>((resolveListen, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) =>
            error.code === "EADDRINUSE" ? resolveListen(false) : reject(error),
        );
        server.listen(port, "127.0.0.1", () => resolveListen(true));
    });
    if (listening) {
        await new Promise<void>((resolveClose, reject) =>
            server.close((error) => (error ? reject(error) : resolveClose())),
        );
    }
    return listening;
}

async function freePort(taken: ReadonlySet<number> = new Set()) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const port = STACK_PORTS.first + Math.floor(Math.random() * (STACK_PORTS.last - STACK_PORTS.first + 1));
        if (!taken.has(port) && (await bindable(port))) {
            return port;
        }
    }
    throw new Error("Could not allocate a local stack port");
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

// The local relay's Session signing secret; production supplies its own as a deployment secret.
const sessionSigningSecret = "local-development-only-session-signing-secret";

export class LocalStack {
    readonly harness: E2EHarness;
    readonly directories: Readonly<Record<"relay" | "chat" | "workspace", string>>;
    readonly relayOrigin: string;
    readonly chatOrigin: string;
    readonly relayPort: number;
    readonly chatPort: number;

    static async create(harness: E2EHarness) {
        const relayPort = await freePort();
        const chatPort = await freePort(new Set([relayPort]));
        const directories = {
            relay: join(harness.workDirectory, "relay"),
            chat: join(harness.workDirectory, "chat"),
            workspace: join(harness.workDirectory, "workspace"),
        };
        await Promise.all(Object.values(directories).map((path) => mkdir(path, { recursive: true })));
        return new LocalStack(harness, directories, relayPort, chatPort);
    }

    constructor(
        harness: E2EHarness,
        directories: Readonly<Record<"relay" | "chat" | "workspace", string>>,
        relayPort: number,
        chatPort: number,
    ) {
        this.harness = harness;
        this.directories = directories;
        this.relayOrigin = `http://127.0.0.1:${relayPort}`;
        this.chatOrigin = `http://127.0.0.1:${chatPort}`;
        this.relayPort = relayPort;
        this.chatPort = chatPort;
    }

    async startRelay() {
        const revision = (await this.harness.run("git", ["rev-parse", "HEAD"], { cwd: mortyRepository })).stdout.trim();
        this.harness.record("mortyRevision", revision);
        await this.harness.stage("migrate-relay", async () => {
            await migrate(
                this.harness,
                relayConfiguration,
                "RELAY_DIRECTORY_DATABASE",
                this.directories.relay,
                mortyRepository,
            );
        });
        const application = await this.harness.stage("provision-morty-service", () =>
            provisionLocalService(relayConfiguration, this.directories.relay, this.harness.signal),
        );
        await this.harness.stage("start-relay", async () => {
            await this.harness.startWorker(
                "morty-relay",
                wranglerExecutable,
                [
                    "dev",
                    "--config",
                    relayConfiguration,
                    "--var",
                    `APP_ORIGIN:${this.chatOrigin}`,
                    "--var",
                    `MORTY_RELAY_URL:${this.relayOrigin}`,
                    "--var",
                    `MORTY_SERVICE_SECRET:${application.appSecret}`,
                    "--var",
                    `MORTY_SESSION_SIGNING_SECRET:${sessionSigningSecret}`,
                    "--ip",
                    "127.0.0.1",
                    "--port",
                    String(this.relayPort),
                    "--inspector-port",
                    "0",
                    "--persist-to",
                    this.directories.relay,
                ],
                { cwd: mortyRepository },
            );
            await this.harness.checkHttp(`${this.relayOrigin}/morty/api/dashboard/health`, "morty-relay health");
        });
        return { ...application, sessionSigningSecret };
    }

    async startChat(application: { readonly appId: string; readonly appSecret: string }) {
        const variables = {
            APP_ORIGIN: this.chatOrigin,
            MORTY_SERVICE_SECRET: application.appSecret,
            MORTY_RELAY_URL: this.relayOrigin,
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
