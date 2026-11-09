import { eq } from "drizzle-orm";
import { z } from "zod";
import { sessionCreation } from "../../schema/acp-session-store/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

const receiptSchema = z
    .object({
        operationId: z.string(),
        requestHash: z.string(),
        resultJson: z.string().nullable(),
    })
    .readonly();

export class SessionCreationTable {
    readonly #database: LocalSqliteDatabase;

    constructor(database: LocalSqliteDatabase) {
        this.#database = database;
    }

    readonly read = (operationId: string): z.infer<typeof receiptSchema> | undefined => {
        const row: unknown = this.#database.orm
            .select()
            .from(sessionCreation)
            .where(eq(sessionCreation.operationId, operationId))
            .get();
        return row === undefined ? undefined : receiptSchema.parse(row);
    };

    readonly start = (operationId: string, requestHash: string): void => {
        this.#database.orm.insert(sessionCreation).values({ operationId, requestHash }).run();
    };

    readonly complete = (operationId: string, resultJson: string): void => {
        this.#database.orm
            .update(sessionCreation)
            .set({ resultJson })
            .where(eq(sessionCreation.operationId, operationId))
            .run();
    };

    readonly remove = (operationId: string): void => {
        this.#database.orm.delete(sessionCreation).where(eq(sessionCreation.operationId, operationId)).run();
    };
}
