import * as v from "valibot";

export type GetToken = (signal: AbortSignal) => Promise<string | null>;

export class RequestError extends Error {}

export const request = async (
    path: string,
    getToken: GetToken,
    fetchRequest: (request: Request) => Promise<Response>,
    signal: AbortSignal,
    method = "GET",
    body?: unknown,
): Promise<unknown> => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const token = await getToken(deadline);
    deadline.throwIfAborted();
    const response = await fetchRequest(
        new Request(path, {
            method,
            headers: {
                ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
                "Content-Type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: deadline,
        }),
    );
    if (response.status === 204) {
        return null;
    }
    const value: unknown = await response.json();
    if (!response.ok) {
        const parsed = v.safeParse(v.object({ error: v.object({ message: v.string() }) }), value);
        throw new RequestError(parsed.success ? parsed.output.error.message : "The request failed. Please try again.");
    }
    return value;
};
