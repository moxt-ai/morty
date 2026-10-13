import * as v from "valibot";

export interface IndexedDBEntry<T> {
    readonly key: string;
    readonly schema: v.GenericSchema<T>;
}

const databaseSchema = {
    name: "morty-web",
    stores: {
        values: {
            keyPath: "key",
            name: "values",
        },
    },
    version: 1,
} as const;

const storedValueSchema = v.object({
    key: v.string(),
    value: v.unknown(),
});

function requestResult<T>(request: IDBRequest<T>, signal: AbortSignal): Promise<T | null> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: T | null) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener("abort", aborted);
            resolve(value);
        };
        const aborted = () => finish(null);
        signal.addEventListener("abort", aborted, { once: true });
        request.addEventListener("success", () => finish(request.result), { once: true });
        request.addEventListener("error", () => finish(null), { once: true });
        if (signal.aborted) {
            finish(null);
        }
    });
}

async function openDatabase(signal: AbortSignal): Promise<IDBDatabase | null> {
    let factory: IDBFactory | undefined;
    try {
        factory = globalThis.indexedDB;
    } catch {
        return null;
    }
    if (factory === undefined) {
        return null;
    }
    let request: IDBOpenDBRequest;
    try {
        request = factory.open(databaseSchema.name, databaseSchema.version);
    } catch {
        return null;
    }
    request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(databaseSchema.stores.values.name)) {
            database.createObjectStore(databaseSchema.stores.values.name, {
                keyPath: databaseSchema.stores.values.keyPath,
            });
        }
    });
    request.addEventListener("blocked", () => request.transaction?.abort(), { once: true });
    request.addEventListener("success", () => {
        if (signal.aborted) {
            request.result.close();
        }
    });
    return await requestResult(request, signal);
}

async function withDatabase<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore, signal: AbortSignal) => Promise<T | null>,
    signal: AbortSignal,
): Promise<T | null> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(1_000)]);
    const database = await openDatabase(deadline);
    if (database === null || deadline.aborted) {
        database?.close();
        return null;
    }
    try {
        const transaction = database.transaction(databaseSchema.stores.values.name, mode);
        const abort = () => {
            try {
                transaction.abort();
            } catch {}
        };
        deadline.addEventListener("abort", abort, { once: true });
        try {
            return await operation(transaction.objectStore(databaseSchema.stores.values.name), deadline);
        } finally {
            deadline.removeEventListener("abort", abort);
        }
    } catch {
        return null;
    } finally {
        database.close();
    }
}

export const centralIndexedDB = {
    /** Reads and validates a structured value; null means absent, invalid, unavailable, or timed out. */
    get: async <T>(entry: IndexedDBEntry<T>, signal: AbortSignal): Promise<T | null> =>
        await withDatabase(
            "readonly",
            async (store, operationSignal) => {
                const result = await requestResult(store.get(entry.key), operationSignal);
                const stored = v.safeParse(storedValueSchema, result);
                if (!stored.success || stored.output.key !== entry.key) {
                    return null;
                }
                const value = v.safeParse(entry.schema, stored.output.value);
                return value.success ? value.output : null;
            },
            signal,
        ),
    /** Validates and stores a structured value; failures are intentionally ignored. */
    set: async <T>(entry: IndexedDBEntry<T>, value: T, signal: AbortSignal): Promise<void> => {
        const parsed = v.safeParse(entry.schema, value);
        if (!parsed.success) {
            return;
        }
        await withDatabase(
            "readwrite",
            async (store, operationSignal) => {
                await requestResult(store.put({ key: entry.key, value: parsed.output }), operationSignal);
                return null;
            },
            signal,
        );
    },
};

function scopedKey(prefix: string, ...parts: readonly string[]): string {
    return `${prefix}${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}

const timestampSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8_640_000_000_000_000));
const sessionLastSentMessageSchema = v.pipe(
    v.object({
        commandId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        sentAt: timestampSchema,
    }),
    v.readonly(),
);

export type SessionLastSentMessage = v.InferOutput<typeof sessionLastSentMessageSchema>;

export const sessionLastSentMessageEntry = (sessionId: string): IndexedDBEntry<SessionLastSentMessage> => ({
    key: scopedKey("morty:session-last-sent-message:v1:", sessionId),
    schema: sessionLastSentMessageSchema,
});
