import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MortyRuntimeEngine } from "../../src/engine/runtime/engine.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";

it("Given a credential outside the Computer token format, When an embedding host runs a provided connection, Then configuration is rejected before workspace creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-computer-credential-"));
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
                        computerId: "channel-1",
                        defaultWorkspace: join(directory, "workspace"),
                        relayUrl: "wss://relay.example.com/morty/api/v1/computers/connect",
                        credentials: memoryComputerCredentials("a".repeat(31)),
                    },
                },
                signal: AbortSignal.timeout(5_000),
            }),
        ).rejects.toMatchObject({
            code: "runtime_configuration_invalid",
            message: "The Computer relay credential is invalid",
        });
        expect(await readdir(directory)).not.toContain("workspace");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
