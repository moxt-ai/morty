import * as v from "valibot";

/**
 * Central management of every value the web application persists in browser
 * session storage. Business modules never touch `window.sessionStorage`
 * directly; they read and write through `centralSessionStorage` with an entry
 * registered here. Each entry owns its stored key name, its value schema, and
 * its encode/decode contract:
 *
 * - `decode` returns `null` for anything it cannot represent; callers treat
 *   that value as absent.
 * - `encode` failure skips the write entirely.
 */

export interface SessionStorageEntry<T> {
    readonly key: string;
    readonly schema: v.GenericSchema<T>;
    readonly encode: (value: T) => string;
    readonly decode: (raw: string) => T | null;
}

/** Entry with a fully custom encode/decode contract. */
function customSessionStorageEntry<T>(options: {
    readonly key: string;
    readonly schema: v.GenericSchema<T>;
    readonly encode: (value: T) => string;
    readonly decode: (raw: string) => T | null;
}): SessionStorageEntry<T> {
    return {
        key: options.key,
        schema: options.schema,
        encode: options.encode,
        decode: options.decode,
    };
}

export const centralSessionStorage = {
    /** Reads and decodes; null when absent, undecodable, or storage is unavailable. */
    read: <T>(entry: SessionStorageEntry<T>): T | null => {
        let raw: string | null;
        try {
            raw = window.sessionStorage.getItem(entry.key);
        } catch {
            return null;
        }
        return raw === null ? null : entry.decode(raw);
    },
    /** Removes the stored value. */
    remove: (entry: SessionStorageEntry<never> | { readonly key: string }): void => {
        try {
            window.sessionStorage.removeItem(entry.key);
        } catch {}
    },
    /** Encodes and stores; a failed encode or unavailable storage skips the write. */
    write: <T>(entry: SessionStorageEntry<T>, value: T): void => {
        let raw: string;
        try {
            raw = entry.encode(value);
        } catch {
            return;
        }
        try {
            window.sessionStorage.setItem(entry.key, raw);
        } catch {}
    },
};

function scopedKey(prefix: string, ...parts: readonly string[]): string {
    return `${prefix}${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}

// ---------------------------------------------------------------------------
// Unsent message drafts
// ---------------------------------------------------------------------------

const messageDraftSchema = v.pipe(v.string(), v.maxLength(100_000));

/** Entry whose value is stored as the raw string itself. */
function stringSessionStorageEntry(options: {
    readonly key: string;
    readonly schema: v.GenericSchema<string>;
}): SessionStorageEntry<string> {
    return {
        key: options.key,
        schema: options.schema,
        encode: (value) => v.parse(options.schema, value),
        decode: (raw) => {
            const parsed = v.safeParse(options.schema, raw);
            return parsed.success ? parsed.output : null;
        },
    };
}

/** One-time confirmation carried across the existing access-ending page reload. */
export const accessEndedNoticeEntry = stringSessionStorageEntry({
    key: "morty:access-ended:v1",
    schema: v.literal("ended"),
});

export const accessEndedComputerEntry = stringSessionStorageEntry({
    key: "morty:access-ended-computer:v1",
    schema: v.pipe(v.string(), v.maxLength(256)),
});

/** Carries first-visit guidance from a successful native handoff to its session. */
export const sessionWelcomeEntry = (botId: string, sessionId: string): SessionStorageEntry<"pending"> => ({
    key: scopedKey("morty:session-welcome:v1:", botId, sessionId),
    schema: v.literal("pending"),
    encode: (value) => v.parse(v.literal("pending"), value),
    decode: (raw) => (raw === "pending" ? "pending" : null),
});

export const newConversationDraftEntry = (botId: string): SessionStorageEntry<string> =>
    stringSessionStorageEntry({
        key: scopedKey("morty:message-draft:new:v1:", botId),
        schema: messageDraftSchema,
    });

export const sessionDraftEntry = (sessionId: string): SessionStorageEntry<string> =>
    stringSessionStorageEntry({
        key: scopedKey("morty:message-draft:session:v1:", sessionId),
        schema: messageDraftSchema,
    });

const rememberedSessionSchema = v.pipe(
    v.object({
        id: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
        title: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
    }),
    v.readonly(),
);

export type RememberedSession = v.InferOutput<typeof rememberedSessionSchema>;

/** Display-only context for this tab, scoped to the authenticated identity; never grants access. */
export const rememberedSessionEntry = (identity: string): SessionStorageEntry<RememberedSession> =>
    customSessionStorageEntry({
        key: scopedKey("morty:remembered-session:v1:", identity),
        schema: rememberedSessionSchema,
        encode: (value) => JSON.stringify(v.parse(rememberedSessionSchema, value)),
        decode: (raw) => {
            try {
                const parsed = v.safeParse(rememberedSessionSchema, JSON.parse(raw));
                return parsed.success ? parsed.output : null;
            } catch {
                return null;
            }
        },
    });

// ---------------------------------------------------------------------------
// Conversation sidebar layout
// ---------------------------------------------------------------------------

const sidebarLayoutValueSchema = v.pipe(
    v.variant("kind", [
        v.object({ kind: v.literal("expanded"), width: v.pipe(v.number(), v.minValue(220), v.maxValue(380)) }),
        v.object({
            kind: v.literal("collapsed"),
            rememberedWidth: v.pipe(v.number(), v.minValue(220), v.maxValue(380)),
        }),
    ]),
    v.readonly(),
);

type StoredSidebarLayout = v.InferOutput<typeof sidebarLayoutValueSchema>;

/** Falls back to null for values the layout state cannot represent. */
const _sidebarLayoutEntry = customSessionStorageEntry<StoredSidebarLayout>({
    key: "mobius:conversation-sidebar-layout",
    schema: sidebarLayoutValueSchema,
    encode: (value) => JSON.stringify(value),
    decode: (raw): StoredSidebarLayout | null => {
        try {
            const parsed = v.safeParse(sidebarLayoutValueSchema, JSON.parse(raw));
            return parsed.success ? parsed.output : null;
        } catch {
            return null;
        }
    },
});
