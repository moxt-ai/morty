import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
                    appId: "platform_app",
                    channelId: "channel_directory",
                    defaultWorkspace: join(directory, "workspace"),
                    pairingId: "pairing_directory",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "runtime_directory",
                },
                signal,
            );
            expect(connection.appId).toBe("platform_app");
            expect(connection).not.toHaveProperty("applicationId");
            const record: unknown = JSON.parse(
                await readFile(installation.connectionPath(connection.connectionId), "utf8"),
            );
            expect(record).not.toHaveProperty("applicationId");
            expect(record).toMatchObject({ appId: "platform_app", version: 6 });
            const [indexFile] = await readdir(join(installation.stateDirectory, "channels"));
            if (indexFile === undefined) {
                throw new Error("The saved connection has no channel index");
            }
            const index: unknown = JSON.parse(
                await readFile(join(installation.stateDirectory, "channels", indexFile), "utf8"),
            );
            expect(index).not.toHaveProperty("applicationId");
            expect(index).toMatchObject({ version: 2 });
            await expect(installation.readConnection(connection.connectionId, signal)).resolves.toEqual(connection);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it.each(["connection", "index"])(
        "Given a retired %s format, When the Runtime restores or reuses it, Then it rejects it without rewriting saved state",
        async (retired) => {
            const directory = await mkdtemp(join(tmpdir(), "morty-retired-pairing-"));
            const signal = new AbortController().signal;
            try {
                const installation = await RuntimeInstallationStore.open(join(directory, "data"), signal);
                const input = {
                    appId: "app_current",
                    channelId: "channel_current",
                    defaultWorkspace: join(directory, "workspace"),
                    pairingId: "pairing_current",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "runtime_current",
                };
                const current = await installation.saveConnection(input, signal);
                const channelHash = createHash("sha256").update(input.channelId).digest("hex");
                const path =
                    retired === "connection"
                        ? installation.connectionPath(current.connectionId)
                        : join(installation.stateDirectory, "channels", `mci_${channelHash}.json`);
                const before = JSON.stringify({
                    ...JSON.parse(await readFile(path, "utf8")),
                    version: retired === "connection" ? 5 : 1,
                    applicationId: "com.earlier.host",
                });
                await writeFile(path, before, { mode: 0o600 });
                if (retired === "connection") {
                    await expect(installation.readConnection(current.connectionId, signal)).rejects.toMatchObject({
                        code: "invalid_connection",
                    });
                    await expect(
                        installation.setConnectionActivation(current.connectionId, "stopped", signal),
                    ).rejects.toMatchObject({ code: "invalid_connection" });
                } else {
                    await expect(installation.saveConnection(input, signal)).rejects.toMatchObject({
                        code: "invalid_connection",
                    });
                }
                expect(await readFile(path, "utf8")).toBe(before);
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        },
    );

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
                    appId: "app_context",
                    channelId: "channel_context",
                    defaultWorkspace: join(stateRoot, "workspace"),
                    pairingId: "pairing_context",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "runtime_context",
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
                    appId: "app_new",
                    channelId: "channel_new",
                    defaultWorkspace: join(stateRoot, "workspace"),
                    pairingId: "pairing_new",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "b".repeat(43),
                    runtimeId: "runtime_new",
                },
                signal,
            );
            await rename(relocated, join(stateRoot, "installations", "build.morty.cli"));
            await expect(original.readConnection(saved.connectionId, signal)).resolves.toEqual(saved);
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
                installation.connectionPath(connectionId),
                JSON.stringify({
                    activation: "active",
                    appId: "app_old",
                    applicationId: "build.morty.cli",
                    channelId: "old_channel",
                    connectionId,
                    defaultWorkspace: "/workspace/old",
                    installationId: installation.installationId,
                    kind: "verified",
                    pairingId: "old_pairing",
                    relayOrigin: "https://relay.example.com/",
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "old_runtime",
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
        const channelId = "shared:channel";
        try {
            const morty = await RuntimeInstallationStore.open(join(stateRoot, "morty-data"), signal);
            const moxt = await RuntimeInstallationStore.open(join(stateRoot, "moxt-data"), signal);
            const mortyConnection = await morty.saveConnection(
                {
                    appId: "app_morty",
                    channelId,
                    defaultWorkspace: "/workspace/morty",
                    pairingId: "pairing_morty",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "runtime_morty",
                },
                signal,
            );
            const moxtConnection = await moxt.saveConnection(
                {
                    appId: "app_moxt",
                    channelId,
                    defaultWorkspace: "/workspace/moxt",
                    pairingId: "pairing_moxt",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "b".repeat(43),
                    runtimeId: "runtime_moxt",
                },
                signal,
            );

            const resumed = await moxt.readConnection(moxtConnection.connectionId, signal);

            expect(resumed.channelId).toBe(channelId);
            expect(resumed).toBeInstanceOf(VerifiedRuntimeConnection);
            if (!(resumed instanceof VerifiedRuntimeConnection)) {
                throw new Error("Expected a verified Runtime connection");
            }
            expect(resumed.runtimeId).toBe("runtime_moxt");
            expect(resumed.appId).toBe("app_moxt");
            await expect(moxt.listConnections(signal)).resolves.toEqual([resumed]);
            await expect(moxt.readConnectionForPairing("pairing_moxt", signal)).resolves.toEqual(resumed);
            expect(morty.connectionPath(mortyConnection.connectionId)).not.toContain("moxt-data");
            expect(moxt.connectionPath(moxtConnection.connectionId)).toContain("moxt-data");
            expect(morty.connectionPath(mortyConnection.connectionId)).not.toContain(channelId);
            expect(moxt.connectionPath(moxtConnection.connectionId)).not.toContain(channelId);
            expect(await readdir(join(moxt.stateDirectory, "channels"))).toEqual([
                expect.stringMatching(/^mci_[a-f0-9]{64}\.json$/),
            ]);
            await expect(morty.readConnection(moxtConnection.connectionId, signal)).rejects.toMatchObject({
                code: "connection_not_found",
            } satisfies Pick<RuntimeInstallationStoreError, "code">);
            await writeFile(
                morty.connectionPath(moxtConnection.connectionId),
                await readFile(moxt.connectionPath(moxtConnection.connectionId)),
                { mode: 0o600 },
            );
            await expect(morty.readConnection(moxtConnection.connectionId, signal)).rejects.toMatchObject({
                code: "connection_owner_mismatch",
            });
        } finally {
            await rm(stateRoot, { force: true, recursive: true });
        }
    });
});
