export interface SqlDatabase {
    readonly batch: (
        statements: readonly {
            readonly query: string;
            readonly values: readonly unknown[];
        }[],
        signal: AbortSignal,
    ) => Promise<void>;
    readonly first: (query: string, values: readonly unknown[], signal: AbortSignal) => Promise<unknown>;
    readonly run: (
        query: string,
        values: readonly unknown[],
        signal: AbortSignal,
    ) => Promise<{ readonly meta: { readonly changes: number } }>;
}
