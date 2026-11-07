import { mortyStateDirectory } from "@morty-build/local-state";
import { z } from "zod";

const stateRootSchema = z.string().brand<"StateRoot">();

/**
 * The directory MORTY_STATE_DIRECTORY names. It holds the shared data pointer, current data containers,
 * the default workspace, and the control installation. An installation directory is never a state root.
 */
export type StateRoot = z.infer<typeof stateRootSchema>;

export function readStateDirectory(environment: Readonly<NodeJS.ProcessEnv> = process.env): StateRoot {
    return stateRootSchema.parse(mortyStateDirectory(environment));
}
