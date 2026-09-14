import * as v from "valibot";

const anonymousToken = v.pipe(v.string(), v.regex(/^mobius_anon_v1_[A-Za-z0-9_-]{43}$/u));
const transferCode = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u));
const userRow = v.pipe(v.object({ userId: v.string() }), v.readonly());
const oneTimeCredentialLifetime = 24 * 60 * 60 * 1000;

interface Database {
    readonly batch: (statements: readonly D1PreparedStatement[]) => Promise<readonly D1Result[]>;
    readonly prepare: (query: string) => D1PreparedStatement;
}

function isDatabase(value: unknown): value is Database {
    return (
        typeof value === "object" &&
        value !== null &&
        "prepare" in value &&
        typeof value.prepare === "function" &&
        "batch" in value &&
        typeof value.batch === "function"
    );
}

function randomSecret(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
}

async function digest(value: string): Promise<string> {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface AnonymousIdentity {
    readonly token: string;
    readonly userId: string;
}

export interface IdentityTransfer {
    readonly code: string;
    readonly expiresAt: number;
}

export type BindingResult =
    | { readonly kind: "bound"; readonly userId: string }
    | { readonly kind: "conflict" }
    | { readonly kind: "invalid-local-user" };

export class IdentityStorage {
    readonly #database: unknown;

    constructor(database: unknown) {
        this.#database = database;
    }

    readonly #requireDatabase = (): Database => {
        if (!isDatabase(this.#database)) {
            throw new IdentityStorageError("IDENTITY_UNAVAILABLE", "Identity storage is unavailable.");
        }
        return this.#database;
    };

    readonly createAnonymous = async (now: number, signal: AbortSignal): Promise<AnonymousIdentity> => {
        signal.throwIfAborted();
        const userId = `usr_${crypto.randomUUID()}`;
        const credentialId = `cred_${crypto.randomUUID()}`;
        const token = `mobius_anon_v1_${randomSecret()}`;
        await this.#requireDatabase().batch([
            this.#requireDatabase().prepare("INSERT INTO app_user (id, created_at) VALUES (?, ?)").bind(userId, now),
            this.#requireDatabase()
                .prepare(
                    "INSERT INTO anonymous_credential (id, user_id, token_hash, status, created_at) VALUES (?, ?, ?, 'active', ?)",
                )
                .bind(credentialId, userId, await digest(token), now),
        ]);
        signal.throwIfAborted();
        return { token, userId };
    };

    readonly authenticateAnonymous = async (token: string, signal: AbortSignal): Promise<string | null> => {
        const parsed = v.safeParse(anonymousToken, token);
        if (!parsed.success) {
            return null;
        }
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .prepare("SELECT user_id AS userId FROM anonymous_credential WHERE token_hash = ? AND status = 'active'")
            .bind(await digest(parsed.output))
            .first();
        signal.throwIfAborted();
        const row = v.safeParse(userRow, result);
        return row.success ? row.output.userId : null;
    };

    readonly createTransfer = async (userId: string, now: number, signal: AbortSignal): Promise<IdentityTransfer> => {
        signal.throwIfAborted();
        const code = randomSecret();
        const expiresAt = now + oneTimeCredentialLifetime;
        await this.#requireDatabase()
            .prepare(
                "INSERT INTO identity_transfer (id, code_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(`transfer_${crypto.randomUUID()}`, await digest(code), userId, expiresAt, now)
            .run();
        signal.throwIfAborted();
        return { code, expiresAt };
    };

    readonly redeemTransfer = async (
        code: string,
        now: number,
        signal: AbortSignal,
    ): Promise<AnonymousIdentity | null> => {
        const parsed = v.safeParse(transferCode, code);
        if (!parsed.success) {
            return null;
        }
        signal.throwIfAborted();
        const database = this.#requireDatabase();
        const codeHash = await digest(parsed.output);
        const claimNonce = crypto.randomUUID();
        const credentialId = `cred_${crypto.randomUUID()}`;
        const token = `mobius_anon_v1_${randomSecret()}`;
        const results = await database.batch([
            database
                .prepare(
                    "UPDATE identity_transfer SET consumed_at = ?, claim_nonce = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?",
                )
                .bind(now, claimNonce, codeHash, now),
            database
                .prepare(
                    "INSERT INTO anonymous_credential (id, user_id, token_hash, status, created_at) SELECT ?, user_id, ?, 'active', ? FROM identity_transfer WHERE code_hash = ? AND claim_nonce = ?",
                )
                .bind(credentialId, await digest(token), now, codeHash, claimNonce),
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1) {
            return null;
        }
        const row = await database
            .prepare("SELECT user_id AS userId FROM anonymous_credential WHERE id = ?")
            .bind(credentialId)
            .first();
        const user = v.parse(userRow, row);
        return { token, userId: user.userId };
    };

    readonly clerkBinding = async (clerkUserId: string, signal: AbortSignal): Promise<string | null> => {
        signal.throwIfAborted();
        const row = await this.#requireDatabase()
            .prepare("SELECT user_id AS userId FROM clerk_user_binding WHERE clerk_user_id = ?")
            .bind(clerkUserId)
            .first();
        signal.throwIfAborted();
        const parsed = v.safeParse(userRow, row);
        return parsed.success ? parsed.output.userId : null;
    };

    readonly createPairing = async (
        userId: string,
        botId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<IdentityTransfer> => {
        signal.throwIfAborted();
        const code = randomSecret();
        const expiresAt = now + oneTimeCredentialLifetime;
        await this.#requireDatabase()
            .prepare("INSERT INTO agent_pairing_ticket (code_hash, user_id, bot_id, expires_at) VALUES (?, ?, ?, ?)")
            .bind(await digest(code), userId, botId, expiresAt)
            .run();
        signal.throwIfAborted();
        return { code, expiresAt };
    };

    readonly redeemPairing = async (
        code: string,
        now: number,
        signal: AbortSignal,
    ): Promise<(AnonymousIdentity & { readonly botId: string }) | null> => {
        if (!v.safeParse(transferCode, code).success) {
            return null;
        }
        signal.throwIfAborted();
        const database = this.#requireDatabase();
        const hash = await digest(code);
        const nonce = crypto.randomUUID();
        const token = `mobius_anon_v1_${randomSecret()}`;
        const results = await database.batch([
            database
                .prepare(
                    "UPDATE agent_pairing_ticket SET consumed_at = ?, claim_nonce = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM managed_bot WHERE managed_bot.bot_id = agent_pairing_ticket.bot_id AND managed_bot.user_id = agent_pairing_ticket.user_id)",
                )
                .bind(now, nonce, hash, now),
            database
                .prepare(
                    "INSERT INTO anonymous_credential (id, user_id, token_hash, status, created_at) SELECT ?, user_id, ?, 'active', ? FROM agent_pairing_ticket WHERE code_hash = ? AND claim_nonce = ?",
                )
                .bind(`cred_${crypto.randomUUID()}`, await digest(token), now, hash, nonce),
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1) {
            return null;
        }
        const row = v.parse(
            v.object({ userId: v.string(), botId: v.string() }),
            await database
                .prepare(
                    "SELECT user_id AS userId, bot_id AS botId FROM agent_pairing_ticket WHERE code_hash = ? AND claim_nonce = ?",
                )
                .bind(hash, nonce)
                .first(),
        );
        signal.throwIfAborted();
        return { ...row, token };
    };

    readonly resolveOrCreateClerk = async (clerkUserId: string, now: number, signal: AbortSignal): Promise<string> => {
        const existing = await this.clerkBinding(clerkUserId, signal);
        if (existing !== null) {
            return existing;
        }
        const database = this.#requireDatabase();
        await database.batch([
            database.prepare("INSERT OR IGNORE INTO app_user (id, created_at) VALUES (?, ?)").bind(clerkUserId, now),
            database
                .prepare(
                    "INSERT OR IGNORE INTO clerk_user_binding (clerk_user_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
                )
                .bind(clerkUserId, clerkUserId, now, now),
        ]);
        signal.throwIfAborted();
        const resolved = await this.clerkBinding(clerkUserId, signal);
        if (resolved === null) {
            throw new IdentityStorageError("IDENTITY_UNAVAILABLE", "Identity binding could not be created.");
        }
        return resolved;
    };

    readonly bindClerk = async (
        clerkUserId: string,
        localUserId: string,
        action: "bind" | "discard-local" | "override",
        now: number,
        signal: AbortSignal,
    ): Promise<BindingResult> => {
        const current = await this.clerkBinding(clerkUserId, signal);
        if (current === localUserId) {
            return { kind: "bound", userId: current };
        }
        const database = this.#requireDatabase();
        if (action === "bind") {
            if (current !== null) {
                return { kind: "conflict" };
            }
            const result = await database
                .prepare(
                    "INSERT INTO clerk_user_binding (clerk_user_id, user_id, created_at, updated_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM clerk_user_binding WHERE clerk_user_id = ?) AND NOT EXISTS (SELECT 1 FROM clerk_user_binding WHERE user_id = ?)",
                )
                .bind(clerkUserId, localUserId, now, now, clerkUserId, localUserId)
                .run();
            signal.throwIfAborted();
            return result.meta.changes === 1 ? { kind: "bound", userId: localUserId } : { kind: "conflict" };
        }
        if (current === null) {
            return { kind: "conflict" };
        }
        if (action === "override") {
            const result = await database
                .prepare(
                    "UPDATE clerk_user_binding SET user_id = ?, updated_at = ? WHERE clerk_user_id = ? AND user_id = ? AND NOT EXISTS (SELECT 1 FROM clerk_user_binding WHERE user_id = ?)",
                )
                .bind(localUserId, now, clerkUserId, current, localUserId)
                .run();
            signal.throwIfAborted();
            return result.meta.changes === 1 ? { kind: "bound", userId: localUserId } : { kind: "invalid-local-user" };
        }
        const localBinding = await database
            .prepare("SELECT user_id AS userId FROM clerk_user_binding WHERE user_id = ?")
            .bind(localUserId)
            .first();
        if (localBinding !== null) {
            return { kind: "invalid-local-user" };
        }
        await database.batch([
            database.prepare("DELETE FROM agent_pairing_ticket WHERE user_id = ?").bind(localUserId),
            database.prepare("DELETE FROM identity_transfer WHERE user_id = ?").bind(localUserId),
            database.prepare("DELETE FROM anonymous_credential WHERE user_id = ?").bind(localUserId),
            database.prepare("DELETE FROM chat_access_token WHERE user_id = ?").bind(localUserId),
            database.prepare("DELETE FROM chat_session WHERE user_id = ?").bind(localUserId),
            database.prepare("DELETE FROM managed_bot WHERE user_id = ?").bind(localUserId),
            database.prepare("DELETE FROM app_user WHERE id = ?").bind(localUserId),
        ]);
        signal.throwIfAborted();
        return { kind: "bound", userId: current };
    };
}

export class IdentityStorageError extends Error {
    readonly code: "IDENTITY_UNAVAILABLE";
    constructor(code: "IDENTITY_UNAVAILABLE", message: string) {
        super(message);
        this.code = code;
        this.name = "IdentityStorageError";
    }
}
