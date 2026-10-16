import { type Identifier, isIdentifier } from "@moxt-ai/mobius-protocol";
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

function decodeJsonWith<T>(schema: v.GenericSchema<T>, raw: string): T | null {
    try {
        const parsed = v.safeParse(schema, JSON.parse(raw));
        return parsed.success ? parsed.output : null;
    } catch {
        return null;
    }
}

/** Entry whose value is stored as JSON, encoded with `JSON.stringify`. */
function jsonSessionStorageEntry<T>(options: {
    readonly key: string;
    readonly schema: v.GenericSchema<T>;
}): SessionStorageEntry<T> {
    return {
        key: options.key,
        schema: options.schema,
        encode: (value) => JSON.stringify(v.parse(options.schema, value)),
        decode: (raw) => decodeJsonWith(options.schema, raw),
    };
}

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
    /** Whether a raw value exists under the entry's key, without decoding it. */
    has: (entry: SessionStorageEntry<never> | { readonly key: string }): boolean => {
        try {
            return window.sessionStorage.getItem(entry.key) !== null;
        } catch {
            return false;
        }
    },
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

const identifierSchema = v.custom<Identifier>(isIdentifier);
const settingIdentifierSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

// ---------------------------------------------------------------------------
// Last agent settings per Bot and agent
// ---------------------------------------------------------------------------

const agentSettingPreferenceSchema = v.pipe(
    v.variant("kind", [
        v.object({
            configId: settingIdentifierSchema,
            kind: v.literal("boolean"),
            value: v.boolean(),
        }),
        v.object({
            configId: settingIdentifierSchema,
            kind: v.literal("select"),
            value: v.pipe(v.string(), v.maxLength(500)),
        }),
    ]),
    v.readonly(),
);
export type AgentSettingPreference = v.InferOutput<typeof agentSettingPreferenceSchema>;

export const lastAgentSettingsEntry = (botId: string, agentRef: string) =>
    jsonSessionStorageEntry({
        key: scopedKey("mobius:last-agent-settings:v1:", botId, agentRef),
        schema: v.pipe(
            v.array(agentSettingPreferenceSchema),
            v.maxLength(100),
            v.check(
                (preferences) =>
                    new Set(preferences.map((preference) => preference.configId)).size === preferences.length,
                "Duplicate setting identifiers",
            ),
            v.readonly(),
        ),
    });

// ---------------------------------------------------------------------------
// Working-directory preferences
// ---------------------------------------------------------------------------

const directoryIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(1_000));
const directoryLabelSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(4_000));

export const lastCwdEntry = (botId: string, runtimeId: string, agentRef: string): SessionStorageEntry<string> =>
    stringSessionStorageEntry({
        key: scopedKey("mobius:last-cwd:", botId, runtimeId, agentRef),
        schema: directoryIdSchema,
    });

const recentCwdPreferenceSchema = v.pipe(
    v.object({ directoryId: directoryIdSchema, directoryLabel: directoryLabelSchema }),
    v.readonly(),
);
export type RecentCwdPreference = v.InferOutput<typeof recentCwdPreferenceSchema>;

export const recentCwdEntry = (botId: string) =>
    jsonSessionStorageEntry({
        key: scopedKey("mobius:recent-cwd:", botId),
        schema: v.pipe(
            v.array(recentCwdPreferenceSchema),
            v.maxLength(10),
            v.check(
                (recent) => new Set(recent.map((preference) => preference.directoryId)).size === recent.length,
                "Duplicate recent directories",
            ),
            v.readonly(),
        ),
    });

// ---------------------------------------------------------------------------
// Unsent message drafts
// ---------------------------------------------------------------------------

const messageDraftSchema = v.pipe(v.string(), v.maxLength(100_000));

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

// ---------------------------------------------------------------------------
// Anonymous identity credentials
// ---------------------------------------------------------------------------

const anonymousTokenSchema = v.pipe(
    v.string(),
    v.regex(
        /^(?:mobius_anon_v2_[A-Za-z0-9_-]{43}|mobius_recovery_v1\.prj_(?:wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43})$/u,
    ),
);
const projectIdSchema = v.pipe(v.string(), v.regex(/^prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}$/u));

const storedAnonymousCredentialSchema = v.pipe(
    v.object({
        botId: identifierSchema,
        projectId: projectIdSchema,
        token: anonymousTokenSchema,
        userId: v.string(),
    }),
    v.readonly(),
);

export const anonymousCredentialEntry = jsonSessionStorageEntry({
    key: "mobius.anonymous-credential.v2",
    schema: storedAnonymousCredentialSchema,
});

const storedProjectScopeSchema = v.pipe(v.object({ projectId: projectIdSchema, userId: v.string() }), v.readonly());

export const projectScopeEntry = jsonSessionStorageEntry({
    key: "mobius.workspace.v2",
    schema: storedProjectScopeSchema,
});
