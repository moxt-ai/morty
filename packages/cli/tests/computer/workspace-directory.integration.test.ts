import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WorkspaceDirectoryService } from "../../src/engine/session/workspace/workspace-directory.ts";

describe("machine directory selection", () => {
    it("Given a paired machine and a default workspace, When the browser browses or directly enters a displayed home path, Then accessible canonical directories are available without granting another workspace", async () => {
        const temporaryDirectory = await mkdtemp(join(homedir(), ".morty-workspace-"));
        const defaultWorkspace = join(temporaryDirectory, "default");
        const outside = join(temporaryDirectory, "outside");
        await mkdir(join(defaultWorkspace, "apps", "web"), { recursive: true });
        await mkdir(outside);
        await symlink(outside, join(defaultWorkspace, "escape"));
        const service = new WorkspaceDirectoryService(defaultWorkspace);
        const signal = new AbortController().signal;

        try {
            expect((await service.list("~", signal)).directoryLabel).toBe("~");
            expect(await service.resolve("~", signal)).toBe(await realpath(homedir()));
            const listing = await service.list(defaultWorkspace, signal);
            expect(listing.entries.map((entry) => entry.name)).toEqual(["apps", "escape"]);
            expect(await service.resolve(listing.directoryLabel, signal)).toBe(await realpath(defaultWorkspace));
            const linked = listing.entries.find((entry) => entry.name === "escape");
            expect(await service.resolve(linked?.directory ?? "missing", signal)).toBe(await realpath(outside));

            const apps = await service.list(listing.entries[0]?.directory ?? "missing", signal);
            expect(apps.directoryLabel).toContain("apps");
            expect(apps.entries.map((entry) => entry.name)).toEqual(["web"]);

            const selected = await service.resolve(apps.entries[0]?.directory ?? "missing", signal);
            expect(selected).toBe(await realpath(join(defaultWorkspace, "apps", "web")));
            await expect(service.resolve("invalid\0path", signal)).rejects.toMatchObject({
                code: "local_authorization_failed",
            });
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
