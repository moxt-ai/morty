import { join } from "node:path";
import {
    RuntimeInstallationStore,
    RuntimeInstallationStoreError,
} from "../../engine/runtime/connection/runtime-installation-store.ts";
import { ensurePrivateDirectory } from "../../engine/storage/files/local-files.ts";
import { validateLocalPath } from "../../engine/util/filesystem/private-path.ts";
import { readStateDirectory } from "../../storage/state-directory.ts";

export async function openMortyInstallation(
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<RuntimeInstallationStore> {
    const root = readStateDirectory(environment);
    try {
        await ensurePrivateDirectory(root);
        await validateLocalPath(root, true, true, signal);
    } catch (cause) {
        signal.throwIfAborted();
        throw new RuntimeInstallationStoreError(
            "installation_unavailable",
            "The local installation cannot be initialized",
            { cause },
        );
    }
    return await RuntimeInstallationStore.open(join(root, "computer"), signal);
}
