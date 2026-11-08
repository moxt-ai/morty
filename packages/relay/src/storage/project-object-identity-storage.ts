import { eq } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { projectObjectIdentity } from "../schema/project-do/project-object-identity.ts";

/** The one Project a Project Durable Object holds, bound by the first request that reaches it. */
export class ProjectObjectIdentityStorage {
    readonly #database: DrizzleSqliteDODatabase;

    constructor(storage: DurableObjectStorage) {
        this.#database = drizzle(storage);
    }

    /** Binds this object to `projectId` when it holds no Project yet; false when it holds another Project. */
    readonly bind = (projectId: string): boolean => {
        const identity = this.#database
            .select({ projectId: projectObjectIdentity.projectId })
            .from(projectObjectIdentity)
            .where(eq(projectObjectIdentity.singleton, 1))
            .get();
        if (identity === undefined) {
            this.#database.insert(projectObjectIdentity).values({ singleton: 1, projectId }).run();
            return true;
        }
        return identity.projectId === projectId;
    };
}
