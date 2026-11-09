import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { installationPointerPath } from "../engine/storage/installation/installation-files.ts";
import { readStateDirectory } from "./state-directory.ts";

/** The configured state directory holds another root's installation data, so Morty must not create a root there. */
export class StateRootError extends Error {
    readonly code = "state_root_is_installation_data";
    readonly owningRoot: string;

    constructor(stateDirectory: string, owningRoot: string) {
        super(
            `MORTY_STATE_DIRECTORY (${stateDirectory}) is Morty installation data, not a state root. ` +
                `Use the state root that owns it: MORTY_STATE_DIRECTORY=${owningRoot}`,
        );
        this.name = "StateRootError";
        this.owningRoot = owningRoot;
    }
}

async function owningRoot(directory: string): Promise<string | null> {
    const application = dirname(directory);
    if (basename(application) !== "machine") {
        return null;
    }
    let pointer: unknown;
    try {
        pointer = JSON.parse(await readFile(installationPointerPath(application), "utf8"));
    } catch {
        return null;
    }
    if (
        typeof pointer !== "object" ||
        pointer === null ||
        !("installationId" in pointer) ||
        pointer.installationId !== basename(directory)
    ) {
        return null;
    }
    return dirname(application);
}

/** Refuse to create a nested root inside an existing machine installation. */
export async function validateStateRoot(environment: Readonly<NodeJS.ProcessEnv>): Promise<void> {
    const directory = readStateDirectory(environment);
    const root = await owningRoot(directory);
    if (root !== null) {
        throw new StateRootError(directory, root);
    }
}
