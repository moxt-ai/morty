import * as v from "valibot";

/**
 * Central management of every value the web application persists in browser
 * local storage. Business modules never touch `window.localStorage` directly;
 * they read and write through `centralLocalStorage` with an entry registered
 * here. Each entry owns its stored key name, its value schema, and its
 * encode/decode contract:
 *
 * - `decode` returns `null` for anything it cannot represent; callers treat
 *   that value as absent.
 * - `encode` failure skips the write entirely.
 */

export interface LocalStorageEntry<T> {
    readonly key: string;
    readonly schema: v.GenericSchema<T>;
    readonly encode: (value: T) => string;
    readonly decode: (raw: string) => T | null;
}

function decodeJsonWith<T>(schema: v.GenericSchema<T>, raw: string): T | null {
    try {
        const parsed = v.safeParse(schema, JSON.parse(raw));
        return parsed.success ? parsed.output : null;
    } catch {
        return null;
    }
}

/** Entry whose value is stored as JSON, encoded with `JSON.stringify`. */
function jsonLocalStorageEntry<T>(options: {
    readonly key: string;
    readonly schema: v.GenericSchema<T>;
}): LocalStorageEntry<T> {
    return {
        key: options.key,
        schema: options.schema,
        encode: (value) => JSON.stringify(value),
        decode: (raw) => decodeJsonWith(options.schema, raw),
    };
}

/** Entry whose value is stored as the raw string itself. */
function stringLocalStorageEntry(options: {
    readonly key: string;
    readonly schema: v.GenericSchema<string>;
}): LocalStorageEntry<string> {
    return {
        key: options.key,
        schema: options.schema,
        encode: (value) => value,
        decode: (raw) => {
            const parsed = v.safeParse(options.schema, raw);
            return parsed.success ? parsed.output : null;
        },
    };
}

export const centralLocalStorage = {
    /** Whether a raw value exists under the entry's key, without decoding it. */
    has: (entry: LocalStorageEntry<never> | { readonly key: string }): boolean => {
        try {
            return window.localStorage.getItem(entry.key) !== null;
        } catch {
            return false;
        }
    },
    /** Reads and decodes; null when absent, undecodable, or storage is unavailable. */
    read: <T>(entry: LocalStorageEntry<T>): T | null => {
        let raw: string | null;
        try {
            raw = window.localStorage.getItem(entry.key);
        } catch {
            return null;
        }
        return raw === null ? null : entry.decode(raw);
    },
    /** Removes the stored value. */
    remove: (entry: LocalStorageEntry<never> | { readonly key: string }): void => {
        try {
            window.localStorage.removeItem(entry.key);
        } catch {}
    },
    /** Encodes and stores; a failed encode or unavailable storage skips the write. */
    write: <T>(entry: LocalStorageEntry<T>, value: T): void => {
        let raw: string;
        try {
            raw = entry.encode(value);
        } catch {
            return;
        }
        try {
            window.localStorage.setItem(entry.key, raw);
        } catch {}
    },
};

function scopedKey(prefix: string, ...parts: readonly string[]): string {
    return `${prefix}${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}

const identifierSchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));

// ---------------------------------------------------------------------------
// Selected Bot per project
// ---------------------------------------------------------------------------

export const selectedBotEntry = (projectId: string): LocalStorageEntry<string> =>
    stringLocalStorageEntry({
        key: scopedKey("mobius.chat.selectedBot.v1:", projectId),
        schema: identifierSchema,
    });

// ---------------------------------------------------------------------------
// Saved channel (Bot) connection per user
// ---------------------------------------------------------------------------

export const userChannelEntry = (userId: string): LocalStorageEntry<string> =>
    stringLocalStorageEntry({
        key: scopedKey("morty:user-channel:", userId),
        schema: identifierSchema,
    });

// ---------------------------------------------------------------------------
// Anonymous identity credentials
// ---------------------------------------------------------------------------

const anonymousTokenSchema = v.pipe(v.string(), v.regex(/^mobius_anon_v2_[A-Za-z0-9_-]{43}$/u));
const workspaceProjectIdSchema = v.pipe(
    v.string(),
    v.regex(/^prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}$/u),
);

const storedAnonymousCredentialSchema = v.pipe(
    v.object({
        projectId: workspaceProjectIdSchema,
        token: anonymousTokenSchema,
        userId: v.string(),
    }),
    v.readonly(),
);

export const anonymousCredentialEntry = jsonLocalStorageEntry({
    key: "mobius.anonymous-credential.v2",
    schema: storedAnonymousCredentialSchema,
});

const storedWorkspaceSchema = v.pipe(
    v.union([
        v.pipe(v.object({ projectId: workspaceProjectIdSchema, userId: v.string() }), v.readonly()),
        v.pipe(v.object({ kind: v.literal("recovery") }), v.readonly()),
    ]),
);

export const workspaceEntry = jsonLocalStorageEntry({
    key: "mobius.workspace.v2",
    schema: storedWorkspaceSchema,
});
