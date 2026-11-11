import * as v from "valibot";
import type { ComputerAccounts } from "../../../../contracts/computer-accounts.ts";
import { ProjectRowSchema } from "../../../../contracts/relay/relay-records.ts";
import { waitForAccount } from "./account-operation.ts";

const ACCOUNT_KEY = "computer-account";

/** A computer's own account record. No global directory or secondary ownership copy. */
export class DurableComputerAccount implements ComputerAccounts {
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        this.#storage = storage;
    }

    readonly #readAccount = async (signal: AbortSignal) => {
        return await waitForAccount(async () => {
            const stored: unknown = await this.#storage.get(ACCOUNT_KEY);
            return stored === undefined ? null : v.parse(ProjectRowSchema, stored);
        }, signal);
    };

    readonly readActiveComputerScope: ComputerAccounts["readActiveComputerScope"] = async (computerId, signal) => {
        const account = await this.#readAccount(signal);
        return account?.computer_id === computerId && account.lifecycle === "active"
            ? { computer_id: computerId, user_id: account.user_id, lifecycle: account.lifecycle }
            : null;
    };

    readonly createComputerAccount: ComputerAccounts["createComputerAccount"] = async (project, signal) => {
        return await waitForAccount(
            () =>
                this.#storage.transaction(async (storage) => {
                    const existing: unknown = await storage.get(ACCOUNT_KEY);
                    if (existing !== undefined) {
                        return v.parse(ProjectRowSchema, existing);
                    }
                    signal.throwIfAborted();
                    await storage.put(ACCOUNT_KEY, project);
                    return project;
                }),
            signal,
        );
    };
}
