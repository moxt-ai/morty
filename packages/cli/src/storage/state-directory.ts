import { mortyStateDirectory } from "@morty-build/local-state";
import { z } from "zod";

const stateRootSchema = z.string().brand<"StateRoot">();

/** The Morty state root contains configuration, the default workspace, and the computer directory. */
export type StateRoot = z.infer<typeof stateRootSchema>;

export function readStateDirectory(environment: Readonly<NodeJS.ProcessEnv> = process.env): StateRoot {
    return stateRootSchema.parse(mortyStateDirectory(environment));
}
