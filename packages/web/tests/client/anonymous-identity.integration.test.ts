import { expect, test } from "vitest";
import { ANONYMOUS_CREDENTIAL_KEY, AnonymousIdentityApi } from "../../src/services/identity/anonymous-identity-api.ts";

class MemoryStorage implements Storage {
    readonly #values = new Map<string, string>();
    get length() {
        return this.#values.size;
    }
    clear() {
        this.#values.clear();
    }
    getItem(key: string) {
        return this.#values.get(key) ?? null;
    }
    key(index: number) {
        return [...this.#values.keys()][index] ?? null;
    }
    removeItem(key: string) {
        this.#values.delete(key);
    }
    setItem(key: string, value: string) {
        this.#values.set(key, value);
    }
}

test("Given a browser without an identity, When Mobius starts twice, Then one generated anonymous credential is persisted and reused", async () => {
    const storage = new MemoryStorage();
    let creations = 0;
    const credential = `mobius_anon_v1_${"a".repeat(43)}`;
    const api = new AnonymousIdentityApi({
        origin: "https://cloud.test",
        storage,
        fetchRequest: async (request) => {
            if (new URL(request.url).pathname === "/mobius-cloud/api/identity/anonymous-users") {
                creations += 1;
                return Response.json({ token: credential, userId: "usr_local" }, { status: 201 });
            }
            return Response.json({ authentication: { kind: "anonymous" }, userId: "usr_local" });
        },
    });
    const signal = new AbortController().signal;

    expect(await api.loadOrCreate(signal)).toEqual({ token: credential, userId: "usr_local" });
    expect(await api.loadOrCreate(signal)).toEqual({ token: credential, userId: "usr_local" });
    expect(storage.getItem(ANONYMOUS_CREDENTIAL_KEY)).toBe(credential);
    expect(creations).toBe(1);
});
