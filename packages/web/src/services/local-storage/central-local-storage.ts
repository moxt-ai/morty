import { isDirectoryIdentifier, isIdentifier, MAX_WORKSPACE_PATH_LENGTH } from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";
import { identityScopeSchema } from "../identity/identity-scope-url.ts";

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
        encode: (value) => JSON.stringify(v.parse(options.schema, value)),
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
        encode: (value) => v.parse(options.schema, value),
        decode: (raw) => {
            const parsed = v.safeParse(options.schema, raw);
            return parsed.success ? parsed.output : null;
        },
    };
}

export const centralLocalStorage = {
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
    jsonLocalStorageEntry({
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
// Last harness per Bot
// ---------------------------------------------------------------------------

/**
 * The harness a Bot last worked in, so a new draft continues there instead of
 * falling back to whichever connected Agent happens to be listed first.
 */
export const lastHarnessEntry = (botId: string): LocalStorageEntry<string> =>
    stringLocalStorageEntry({
        key: scopedKey("mobius:last-harness:v1:", botId),
        schema: settingIdentifierSchema,
    });

// ---------------------------------------------------------------------------
// Working-directory preferences
// ---------------------------------------------------------------------------

const directoryIdSchema = v.custom<string>(isDirectoryIdentifier, "Invalid directory identifier");
const directoryLabelSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_WORKSPACE_PATH_LENGTH));

export const lastCwdEntry = (botId: string, runtimeId: string, agentRef: string): LocalStorageEntry<string> =>
    stringLocalStorageEntry({
        key: scopedKey("mobius:last-cwd:", botId, runtimeId, agentRef),
        schema: directoryIdSchema,
    });

const recentCwdPreferenceSchema = v.pipe(
    v.object({ directoryId: directoryIdSchema, directoryLabel: directoryLabelSchema }),
    v.readonly(),
);
export type RecentCwdPreference = v.InferOutput<typeof recentCwdPreferenceSchema>;

export const recentCwdEntry = (botId: string) =>
    jsonLocalStorageEntry({
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
// Anonymous identity tokens
// ---------------------------------------------------------------------------

const anonymousTokenSchema = v.pipe(
    v.string(),
    v.regex(
        /^(?:mobius_anon_v2_[A-Za-z0-9_-]{43}|mobius_recovery_v1\.prj_(?:wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43})$/u,
    ),
);

/** How many computers this browser remembers. Each needs its user's token, so the tokens share this limit. */
export const MAX_REMEMBERED_COMPUTERS = 10;

const credentialUserIdSchema = v.pipe(v.string(), v.minLength(8), v.maxLength(128));

/**
 * Maps a user identifier to their anonymous access token. Each token is read on its own: another Morty version may
 * store tokens this one cannot read, and those stay stored. The remembered computers decide which tokens are kept.
 */
export const anonymousCredentialsEntry = jsonLocalStorageEntry({
    key: "mobius.anonymous-credentials.v1",
    schema: v.pipe(v.record(v.string(), v.unknown()), v.readonly()),
});

/** A stored token this version can use, or null. */
export function readableCredential(userId: string, token: unknown): string | null {
    return v.is(credentialUserIdSchema, userId) && v.is(anonymousTokenSchema, token) ? token : null;
}

const computerDestinationSchema = v.pipe(
    v.variant("kind", [
        v.object({ kind: v.literal("home") }),
        v.object({ kind: v.literal("session"), sessionId: v.custom<string>(isIdentifier) }),
    ]),
    v.readonly(),
);

const rememberedComputerSchema = v.pipe(
    v.object({
        scope: identityScopeSchema,
        destination: computerDestinationSchema,
        name: v.pipe(v.string(), v.maxLength(256)),
        directory: v.nullable(v.pipe(v.string(), v.maxLength(4096))),
        lastUsedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    }),
    v.readonly(),
);

export type ComputerDestination = v.InferOutput<typeof computerDestinationSchema>;
export type RememberedComputer = v.InferOutput<typeof rememberedComputerSchema>;

/**
 * The computers this browser can open, most recently used first. Their tokens are stored by user. Each record is read
 * on its own, so a record another Morty version stored stays stored even when this version cannot read it.
 */
export const rememberedComputersEntry = jsonLocalStorageEntry({
    key: "morty:remembered-computers:v1",
    schema: v.pipe(v.array(v.unknown()), v.readonly()),
});

/** A stored computer record this version can read, or null. */
export function readableComputer(value: unknown): RememberedComputer | null {
    const parsed = v.safeParse(rememberedComputerSchema, value);
    return parsed.success ? parsed.output : null;
}
