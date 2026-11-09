import { eq } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { computerObjectIdentity } from "../schema/project-do/project-object-identity.ts";

/** The one Project a Account Durable Object holds, bound by the first request that reaches it. */
export class ComputerObjectIdentityStorage {
    readonly #database: DrizzleSqliteDODatabase;

    constructor(storage: DurableObjectStorage) {
        this.#database = drizzle(storage);
    }

    /** Binds this object to `computerId` when it holds no Project yet; false when it holds another Project. */
    readonly bind = (computerId: string): boolean => {
        const identity = this.#database
            .select({ computerId: computerObjectIdentity.computerId })
            .from(computerObjectIdentity)
            .where(eq(computerObjectIdentity.singleton, 1))
            .get();
        if (identity === undefined) {
            this.#database.insert(computerObjectIdentity).values({ singleton: 1, computerId }).run();
            return true;
        }
        return identity.computerId === computerId;
    };
}
