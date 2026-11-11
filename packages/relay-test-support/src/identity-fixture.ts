import * as v from "valibot";

/** Creates an owner through the same public boundary as setup; no cloud service identity is seeded. */
export async function createTestOwner(
    request: (request: Request) => Promise<Response>,
    origin: string,
    signal: AbortSignal,
) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const creationKey = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
    const response = await request(
        new Request(`${origin}/morty/api/computers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ creationKey }),
            signal,
        }),
    );
    if (response.status !== 201) {
        throw new Error(`Owner creation failed (${response.status}): ${await response.text()}`);
    }
    return v.parse(v.object({ token: v.string(), computerId: v.string(), userId: v.string() }), await response.json());
}
