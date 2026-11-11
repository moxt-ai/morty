import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { VerifiedComputerConnection } from "../../src/engine/computer/connection/computer-connection.ts";
import {
    ComputerInstallationStore,
    type ComputerInstallationStoreError,
} from "../../src/engine/computer/connection/computer-installation-store.ts";

describe("Computer installation storage", () => {
    it("Given an ordinary data directory name, When a host saves a connection, Then local storage accepts the path without treating it as an application identity", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-engine-directory-"));
        const signal = new AbortController().signal;
        try {
            const installation = await ComputerInstallationStore.open(join(directory, "data"), signal);
            const connection = await installation.saveConnection(
                {
                    computerId: "channel_directory",
                    defaultWorkspace: join(directory, "workspace"),
                    relayOrigin: new URL("https://relay.example.com/"),
                    computerCredential: "a".repeat(43),
                },
                signal,
            );
            expect(connection).not.toHaveProperty("applicationId");
            const record: unknown = JSON.parse(await readFile(installation.pairingPath, "utf8"));
            expect(record).not.toHaveProperty("applicationId");
            expect(record).not.toHaveProperty("appId");
            await expect(installation.readConnection(connection.pairingGeneration, signal)).resolves.toEqual(
                connection,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("Given an existing installation moved to a differently named directory, When a host opens it explicitly, Then old and new entrypoints retain the same identity and connections", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "morty-engine-context-"));
        const signal = new AbortController().signal;
        try {
            const original = await ComputerInstallationStore.open(
                join(stateRoot, "installations", "build.morty.cli"),
                signal,
            );
            const connection = await original.saveConnection(
                {
                    computerId: "channel_context",
                    defaultWorkspace: join(stateRoot, "workspace"),
                    relayOrigin: new URL("https://relay.example.com/"),
                    computerCredential: "a".repeat(43),
                },
                signal,
            );
            const relocated = join(stateRoot, "renamed-data");
            await rename(join(stateRoot, "installations", "build.morty.cli"), relocated);
            const engine = await ComputerInstallationStore.open(relocated, signal);
            expect(engine.stateDirectory).toBe(relocated);
            await expect(engine.readConnection(connection.pairingGeneration, signal)).resolves.toEqual(connection);
            const saved = await engine.saveConnection(
                {
                    computerId: "channel_new",
                    defaultWorkspace: join(stateRoot, "workspace"),
                    relayOrigin: new URL("https://relay.example.com/"),
                    computerCredential: "b".repeat(43),
                },
                signal,
            );
            await rename(relocated, join(stateRoot, "installations", "build.morty.cli"));
            await expect(original.readConnection(saved.pairingGeneration, signal)).resolves.toEqual(saved);
            await expect(original.removeConnection(connection.pairingGeneration, signal)).rejects.toMatchObject({
                code: "connection_not_found",
            });
            await expect(original.listConnections(signal)).resolves.toEqual([saved]);
        } finally {
            await rm(stateRoot, { recursive: true, force: true });
        }
    });

    it("Given two isolated Engine data directories, When each saves a Computer connection, Then each resumes only its own opaque connection", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "morty-computer-installations-"));
        const signal = new AbortController().signal;
        const computerId = "shared:channel";
        try {
            const morty = await ComputerInstallationStore.open(join(stateRoot, "morty-data"), signal);
            const moxt = await ComputerInstallationStore.open(join(stateRoot, "moxt-data"), signal);
            await morty.saveConnection(
                {
                    computerId,
                    defaultWorkspace: "/workspace/morty",
                    relayOrigin: new URL("https://relay.example.com/"),
                    computerCredential: "a".repeat(43),
                },
                signal,
            );
            const moxtConnection = await moxt.saveConnection(
                {
                    computerId,
                    defaultWorkspace: "/workspace/moxt",
                    relayOrigin: new URL("https://relay.example.com/"),
                    computerCredential: "b".repeat(43),
                },
                signal,
            );

            const resumed = await moxt.readConnection(moxtConnection.pairingGeneration, signal);

            expect(resumed.computerId).toBe(computerId);
            expect(resumed).toBeInstanceOf(VerifiedComputerConnection);
            if (!(resumed instanceof VerifiedComputerConnection)) {
                throw new Error("Expected a verified Computer connection");
            }
            expect(resumed.computerId).toBe(computerId);
            await expect(moxt.listConnections(signal)).resolves.toEqual([resumed]);
            await expect(moxt.currentConnection(signal)).resolves.toEqual(resumed);
            expect(morty.pairingPath).not.toContain("moxt-data");
            expect(moxt.pairingPath).toContain("moxt-data");
            expect(morty.pairingPath).not.toContain(computerId);
            expect(moxt.pairingPath).not.toContain(computerId);

            await expect(morty.readConnection(moxtConnection.pairingGeneration, signal)).rejects.toMatchObject({
                code: "connection_not_found",
            } satisfies Pick<ComputerInstallationStoreError, "code">);
        } finally {
            await rm(stateRoot, { force: true, recursive: true });
        }
    });
});
