import type { WorkspaceDirectoryService } from "./workspace-directory.ts";

export async function resolveSessionDirectory(
    directories: WorkspaceDirectoryService,
    directory: string,
    signal: AbortSignal,
): Promise<{ readonly cwd: string; readonly directoryLabel: string }> {
    const selection = await directories.describe(directory, signal);
    return { cwd: selection.path, directoryLabel: selection.label };
}
