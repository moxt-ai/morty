import * as v from "valibot";

const publicConfigSchema = v.pipe(
    v.object({
        publishableKey: v.pipe(v.string(), v.regex(/^pk_(test|live)_[A-Za-z0-9_-]+$/u)),
    }),
    v.readonly(),
);

export async function getPublicConfig(
    fetchRequest: (request: Request) => Promise<Response>,
    signal: AbortSignal,
): Promise<v.InferOutput<typeof publicConfigSchema>> {
    const response = await fetchRequest(
        new Request(new URL("/morty/api/config", window.location.origin), {
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        }),
    );
    if (!response.ok) {
        throw new Error("Sign-in configuration is unavailable.");
    }
    const body: unknown = await response.json();
    return v.parse(publicConfigSchema, body);
}
