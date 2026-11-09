import { runtimeCredentialSuccessor } from "@morty-build/client/protocol";
import type {
    RuntimeCredentialRotation,
    RuntimeCredentials,
} from "../../src/engine/runtime/connection/runtime-credentials.ts";

/** Keeps a Runtime credential and its rotations in memory, for an embedding host that outlives no restart. */
export function memoryRuntimeCredentials(initial: string): RuntimeCredentials {
    let current = initial;
    let pending: RuntimeCredentialRotation | null = null;
    return {
        prepare: async () => {
            pending ??= { current, successor: runtimeCredentialSuccessor(current) };
            return pending;
        },
        complete: async (rotation) => {
            if (pending?.successor === rotation.successor) {
                current = rotation.successor;
                pending = null;
            }
        },
        held: async () => ({ current, successor: pending?.successor ?? null }),
    };
}
