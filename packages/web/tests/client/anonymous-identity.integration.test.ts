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
    const credential = `mobius_anon_v2_${"a".repeat(43)}`;
    const identity = { token: credential, userId: "usr_local", projectId: `prj_a01_${"a".repeat(24)}` };
    const api = new AnonymousIdentityApi({
        origin: "https://cloud.test",
        storage,
        fetchRequest: async (request) => {
            if (new URL(request.url).pathname === "/mobius-cloud/api/identity/anonymous-users") {
                creations += 1;
                return Response.json(identity, { status: 201 });
            }
            expect(new URL(request.url).pathname).toBe(`/mobius-cloud/api/projects/${identity.projectId}/session`);
            return Response.json({ authentication: { kind: "anonymous" }, userId: "usr_local" });
        },
    });
    const signal = new AbortController().signal;

    expect(await api.loadOrCreate(signal)).toEqual(identity);
    expect(await api.loadOrCreate(signal)).toEqual(identity);
    expect(storage.getItem(ANONYMOUS_CREDENTIAL_KEY)).toBe(JSON.stringify(identity));
    expect(creations).toBe(1);
});
