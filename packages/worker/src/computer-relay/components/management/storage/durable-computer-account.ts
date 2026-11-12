import * as v from "valibot";
import { waitForAccount } from "./account-operation.ts";

const ACCOUNT_KEY = "computer-account";
/** A computer's account: which computer it is. */
const accountSchema = v.object({ computer_id: v.string() });

/** A computer's own account record. No global directory or secondary ownership copy. */
export class DurableComputerAccount {
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        this.#storage = storage;
    }

    /** Whether this object holds the account of `computerId`. */
    readonly isActive = async (computerId: string, signal: AbortSignal): Promise<boolean> =>
        await waitForAccount(async () => {
            const stored: unknown = await this.#storage.get(ACCOUNT_KEY);
            return stored !== undefined && v.parse(accountSchema, stored).computer_id === computerId;
        }, signal);

    /** Creates the account of `computerId`, or keeps the one an earlier request created. */
    readonly create = async (computerId: string, signal: AbortSignal): Promise<void> => {
        await waitForAccount(
            () =>
                this.#storage.transaction(async (storage) => {
                    if ((await storage.get(ACCOUNT_KEY)) !== undefined) {
                        return;
                    }
                    signal.throwIfAborted();
                    await storage.put(ACCOUNT_KEY, { computer_id: computerId });
                }),
            signal,
        );
    };
}
