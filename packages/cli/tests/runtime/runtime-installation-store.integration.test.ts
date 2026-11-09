import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { VerifiedRuntimeConnection } from "../../src/engine/runtime/connection/runtime-connection.ts";
import {
    RuntimeInstallationStore,
    type RuntimeInstallationStoreError,
} from "../../src/engine/runtime/connection/runtime-installation-store.ts";

describe("Runtime installation storage", () => {
    it("Given an ordinary data directory name, When a host saves a connection, Then local storage accepts the path without treating it as an application identity", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-engine-directory-"));
        const signal = new AbortController().signal;
        try {
            const installation = await RuntimeInstallationStore.open(join(directory, "data"), signal);
            const connection = await installation.saveConnection(
                {
                    computerId: "channel_directory",
                    defaultWorkspace: join(directory, "workspace"),
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "a".repeat(43),
                },
                signal,
            );
            expect(connection).not.toHaveProperty("applicationId");
            const record: unknown = JSON.parse(await readFile(installation.pairingPath, "utf8"));
            expect(record).not.toHaveProperty("applicationId");
            expect(record).not.toHaveProperty("appId");
            await expect(installation.readConnection(connection.connectionId, signal)).resolves.toEqual(connection);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("Given an existing installation moved to a differently named directory, When a host opens it explicitly, Then old and new entrypoints retain the same identity and connections", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "morty-engine-context-"));
        const signal = new AbortController().signal;
        try {
            const original = await RuntimeInstallationStore.open(
                join(stateRoot, "installations", "build.morty.cli"),
                signal,
            );
            const connection = await original.saveConnection(
                {
                    computerId: "channel_context",
                    defaultWorkspace: join(stateRoot, "workspace"),
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "a".repeat(43),
                },
                signal,
            );
            const relocated = join(stateRoot, "renamed-data");
            await rename(join(stateRoot, "installations", "build.morty.cli"), relocated);
            const engine = await RuntimeInstallationStore.open(relocated, signal);
            expect(engine.installationId).toBe(original.installationId);
            expect(engine.stateDirectory).toBe(join(relocated, original.installationId));
            await expect(engine.readConnection(connection.connectionId, signal)).resolves.toEqual(connection);
            const saved = await engine.saveConnection(
                {
                    computerId: "channel_new",
                    defaultWorkspace: join(stateRoot, "workspace"),
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "b".repeat(43),
                },
                signal,
            );
            await rename(relocated, join(stateRoot, "installations", "build.morty.cli"));
            await expect(original.readConnection(saved.connectionId, signal)).resolves.toEqual(saved);
            await expect(original.removeConnection(connection.connectionId, signal)).rejects.toMatchObject({
                code: "connection_not_found",
            });
            await expect(original.listConnections(signal)).resolves.toEqual([saved]);
        } finally {
            await rm(stateRoot, { recursive: true, force: true });
        }
    });

    it("Given an obsolete pairing record, When the Runtime restores it, Then it rejects the record without a compatibility fallback", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "morty-obsolete-pairing-"));
        const signal = new AbortController().signal;
        try {
            const installation = await RuntimeInstallationStore.open(
                join(stateRoot, "installations", "build.morty.cli"),
                signal,
            );
            const connectionId = `mcn_${"0".repeat(32)}`;
            await mkdir(join(installation.stateDirectory, "connections"), { recursive: true });
            await writeFile(
                installation.pairingPath,
                JSON.stringify({
                    activation: "active",
                    applicationId: "build.morty.cli",
                    computerId: "old_channel",
                    connectionId,
                    defaultWorkspace: "/workspace/old",
                    installationId: installation.installationId,
                    kind: "verified",
                    relayOrigin: "https://relay.example.com/",
                    runtimeCredential: "a".repeat(43),
                    version: 4,
                }),
                { mode: 0o600 },
            );
            await expect(installation.readConnection(connectionId, signal)).rejects.toMatchObject({
                code: "invalid_connection",
            });
        } finally {
            await rm(stateRoot, { force: true, recursive: true });
        }
    });

    it("Given two isolated Engine data directories, When each saves a Runtime connection, Then each resumes only its own opaque connection", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "morty-runtime-installations-"));
        const signal = new AbortController().signal;
        const computerId = "shared:channel";
        try {
            const morty = await RuntimeInstallationStore.open(join(stateRoot, "morty-data"), signal);
            const moxt = await RuntimeInstallationStore.open(join(stateRoot, "moxt-data"), signal);
            await morty.saveConnection(
                {
                    computerId,
                    defaultWorkspace: "/workspace/morty",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "a".repeat(43),
                },
                signal,
            );
            const moxtConnection = await moxt.saveConnection(
                {
                    computerId,
                    defaultWorkspace: "/workspace/moxt",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "b".repeat(43),
                },
                signal,
            );

            const resumed = await moxt.readConnection(moxtConnection.connectionId, signal);

            expect(resumed.computerId).toBe(computerId);
            expect(resumed).toBeInstanceOf(VerifiedRuntimeConnection);
            if (!(resumed instanceof VerifiedRuntimeConnection)) {
                throw new Error("Expected a verified Runtime connection");
            }
            expect(resumed.computerId).toBe("runtime_moxt");
            await expect(moxt.listConnections(signal)).resolves.toEqual([resumed]);
            await expect(moxt.readConnectionForPairing("pairing_moxt", signal)).resolves.toEqual(resumed);
            expect(morty.pairingPath).not.toContain("moxt-data");
            expect(moxt.pairingPath).toContain("moxt-data");
            expect(morty.pairingPath).not.toContain(computerId);
            expect(moxt.pairingPath).not.toContain(computerId);

            await expect(morty.readConnection(moxtConnection.connectionId, signal)).rejects.toMatchObject({
                code: "connection_not_found",
            } satisfies Pick<RuntimeInstallationStoreError, "code">);
            await writeFile(morty.pairingPath, await readFile(moxt.pairingPath), { mode: 0o600 });
            await expect(morty.readConnection(moxtConnection.connectionId, signal)).rejects.toMatchObject({
                code: "connection_owner_mismatch",
            });
        } finally {
            await rm(stateRoot, { force: true, recursive: true });
        }
    });
});
