import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MortyRuntimeEngine } from "../../src/exports/engine.ts";
import { memoryRuntimeCredentials } from "../support/runtime-credentials.ts";

it("Given a credential outside the Runtime token format, When an embedding host runs a provided connection, Then configuration is rejected before workspace creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-runtime-credential-"));
    try {
        const engine = new MortyRuntimeEngine({
            engineDataDir: join(directory, "engine-data"),
            agentLaunchEnvironment: { PATH: "" },
        });
        await expect(
            engine.runLoop({
                connection: {
                    kind: "provided",
                    connection: {
                        channelId: "channel-1",
                        defaultWorkspace: join(directory, "workspace"),
                        relayUrl: "wss://relay.example.com/morty/api/v1/runtimes/connect",
                        credentials: memoryRuntimeCredentials("a".repeat(31)),
                    },
                },
                signal: AbortSignal.timeout(5_000),
            }),
        ).rejects.toMatchObject({
            code: "runtime_configuration_invalid",
            message: "The Runtime relay credential is invalid",
        });
        expect(await readdir(directory)).not.toContain("workspace");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
