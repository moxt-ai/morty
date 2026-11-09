import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MORTY_API_PREFIX } from "@morty-build/client";
import { expect, it } from "vitest";
import { startTestPlatform } from "../support/platform.ts";

// @no-uc: Performance; validating a directory must not require enumerating its children.
it("describes a selected directory without browsing its children and still rejects unavailable directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "morty-workspace-metadata-"));
    try {
        await mkdir(join(root, "child"));
        const canonical = await realpath(root);
        const directory = canonical;
        await using platform = await startTestPlatform();
        const signal = AbortSignal.timeout(30_000);
        const project = await platform.service.createProject(
            {
                clientReference: `client-${crypto.randomUUID()}`,
                displayName: "Directory metadata",
                idempotencyKey: `project-${crypto.randomUUID()}`,
                locationHint: "wnam",
            },
            signal,
        );
        const runtime = await platform.connectAgent(project.computerId);
        const listing = await runtime.client.runtimes.listWorkspace(directory, signal);
        expect(listing.entries.map((entry) => entry.name)).toContain("child");

        const invalid = await fetch(
            `${platform.baseUrl}${MORTY_API_PREFIX}/v1/computers/${project.computerId}/daemon/workspace`,
            {
                method: "POST",
                headers: { authorization: `Bearer ${platform.appCredential}`, "content-type": "application/json" },
                body: JSON.stringify({ directory, view: "children" }),
                signal,
            },
        );
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: { code: "invalid_request" } });

        // Directory lookup/stat remains permitted, while readdir is denied for ordinary users.
        // The returned metadata contract is the same when a privileged test user ignores chmod.
        await chmod(root, 0o111);
        await expect(runtime.client.runtimes.describeWorkspace(directory, signal)).resolves.toStrictEqual({
            directory,
            directoryLabel: listing.directoryLabel,
        });
        const missing = join(canonical, "missing");
        await expect(runtime.client.runtimes.describeWorkspace(missing, signal)).rejects.toMatchObject({
            code: "local_authorization_failed",
        });
    } finally {
        await chmod(root, 0o755);
        await rm(root, { recursive: true, force: true });
    }
});
