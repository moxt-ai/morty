import { eq } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { accountObjectIdentity } from "../schema/project-do/project-object-identity.ts";

/** The one Project a Account Durable Object holds, bound by the first request that reaches it. */
export class AccountObjectIdentityStorage {
    readonly #database: DrizzleSqliteDODatabase;

    constructor(storage: DurableObjectStorage) {
        this.#database = drizzle(storage);
    }

    /** Binds this object to `accountId` when it holds no Project yet; false when it holds another Project. */
    readonly bind = (accountId: string): boolean => {
        const identity = this.#database
            .select({ accountId: accountObjectIdentity.accountId })
            .from(accountObjectIdentity)
            .where(eq(accountObjectIdentity.singleton, 1))
            .get();
        if (identity === undefined) {
            this.#database.insert(accountObjectIdentity).values({ singleton: 1, accountId }).run();
            return true;
        }
        return identity.accountId === accountId;
    };
}
