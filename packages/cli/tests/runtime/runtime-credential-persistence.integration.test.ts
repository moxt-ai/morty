import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { RuntimeInstallationStore } from "../../src/engine/runtime/connection/runtime-installation-store.ts";

test("Given a rotated connection, When replacement pairing is cancelled, Then the current credential remains usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "morty-credential-cancel-"));
    const signal = new AbortController().signal;
    try {
        const installation = await RuntimeInstallationStore.open(root, signal);
        const input = {
            channelId: "channel_scan",
            defaultWorkspace: root,
            pairingId: "pairing_scan",
            relayOrigin: new URL("https://relay.example.com/"),
            runtimeCredential: "a".repeat(43),
            runtimeId: "runtime_scan",
        };
        const connection = await installation.saveConnection(input, signal);
        const credentials = installation.runtimeCredentials(connection.connectionId);
        const rotation = await credentials.prepare(signal);
        await credentials.complete(rotation, signal);
        expect((await credentials.held(signal)).current === rotation.successor).toBe(true);
        await expect(
            installation.saveConnection({ ...input, pairingId: "pairing_replacement" }, AbortSignal.abort()),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect((await installation.currentConnection(signal))?.connectionId).toBe(connection.connectionId);
        expect((await credentials.held(signal)).current === rotation.successor).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Given a running credential rotation, When the pairing is replaced concurrently, Then the new pairing can read its credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "morty-credential-replace-"));
    const signal = new AbortController().signal;
    try {
        const installation = await RuntimeInstallationStore.open(root, signal);
        const input = {
            channelId: "channel_scan",
            defaultWorkspace: root,
            pairingId: "pairing_scan",
            relayOrigin: new URL("https://relay.example.com/"),
            runtimeCredential: "a".repeat(43),
            runtimeId: "runtime_scan",
        };
        const old = await installation.saveConnection(input, signal);
        const credentials = installation.runtimeCredentials(old.connectionId);
        const rotated = await credentials.prepare(signal);
        await credentials.complete(rotated, signal);
        const replacementHost = await RuntimeInstallationStore.open(root, signal);
        const replacementInput = { ...input, pairingId: "pairing_new", runtimeCredential: "b".repeat(43) };
        const [rotation, pairing] = await Promise.allSettled([
            credentials.prepare(signal),
            replacementHost.saveConnection(replacementInput, signal),
        ]);
        // Contending changes can ask the caller to retry without committing a partial replacement.
        if (pairing.status === "rejected") {
            expect(pairing.reason).toMatchObject({ code: "pairing_busy" });
        }
        const replacement =
            pairing.status === "fulfilled"
                ? pairing.value
                : await replacementHost.saveConnection(replacementInput, signal);
        const current = installation.runtimeCredentials(replacement.connectionId);
        expect((await current.held(signal)).current === replacementInput.runtimeCredential).toBe(true);
        if (rotation.status === "fulfilled") {
            await expect(credentials.complete(rotation.value, signal)).rejects.toMatchObject({
                code: "connection_not_found",
            });
        } else {
            expect(rotation.reason).toMatchObject({ code: "pairing_busy" });
        }
        const next = await current.prepare(signal);
        await installation.setConnectionActivation(replacement.connectionId, "stopped", signal);
        await current.complete(next, signal);
        await installation.setConnectionActivation(replacement.connectionId, "active", signal);
        const reopened = await RuntimeInstallationStore.open(root, signal);
        expect(
            (await reopened.runtimeCredentials(replacement.connectionId).held(signal)).current === next.successor,
        ).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
