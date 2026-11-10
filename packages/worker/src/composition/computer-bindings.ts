import * as v from "valibot";
import { ComputerManagementError } from "../components/management/entity/computer-management.ts";
import {
    type CloudBindings,
    type ProjectStorageBindings,
    projectStorageBindingsSchema,
} from "../infra/cloud-bindings.ts";

export async function computerBindings(
    bindings: CloudBindings,
    computerId: string,
    signal: AbortSignal,
): Promise<CloudBindings & ProjectStorageBindings> {
    signal.throwIfAborted();
    if (bindings.CHAT_COMPUTER_ID !== computerId) {
        throw new ComputerManagementError("PROJECT_CONTEXT_MISMATCH", "The Morty context is invalid.", 400);
    }
    const parsed = v.safeParse(projectStorageBindingsSchema, bindings);
    if (!parsed.success) {
        throw new ComputerManagementError("PROJECT_STORAGE_UNAVAILABLE", "Morty storage is unavailable.", 503);
    }
    return { ...bindings, ...parsed.output };
}
