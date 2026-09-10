import type { SqlDatabase } from "./sql-database";

export interface DatabaseResolver {
    readonly resolve: () => SqlDatabase;
}
