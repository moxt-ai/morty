export function json(body: unknown, status = 200, headers?: Readonly<Record<string, string>>): Response {
    return Response.json(body, {
        status,
        headers: { "Cache-Control": "no-store", ...headers },
    });
}
