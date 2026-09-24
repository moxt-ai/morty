import type { HttpError } from "../../../infra/http-error.ts";
import { createDatabase, type Database } from "../../../schema/project-do/database.ts";

export interface AnonymousIdentity {
    readonly token: string;
    readonly userId: string;
    readonly projectId: string;
}

export function requireIdentityDatabase(binding: unknown): Database {
    const database = createDatabase(binding);
    if (database === null) {
        throw new IdentityStorageError("IDENTITY_UNAVAILABLE", "Identity storage is unavailable.");
    }
    return database;
}

export function randomSecret(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
}

export async function digest(value: string): Promise<string> {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class IdentityStorageError extends Error implements HttpError {
    readonly code: "IDENTITY_UNAVAILABLE";
    constructor(code: "IDENTITY_UNAVAILABLE", message: string) {
        super(message);
        this.code = code;
        this.name = "IdentityStorageError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: 503,
    });
}
