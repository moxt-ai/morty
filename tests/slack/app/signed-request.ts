export function createSignedRequest(request: (url: string, init?: RequestInit) => Promise<Response>) {
    return async (
        url: string,
        body: string,
        timestamp = Math.floor(Date.now() / 1_000),
        secret = "signing-secret",
        contentType = "application/json",
    ): Promise<Response> => {
        const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
        );
        const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
        const hex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
        return await request(url, {
            method: "POST",
            body,
            headers: {
                "Content-Type": contentType,
                "x-slack-request-timestamp": String(timestamp),
                "x-slack-signature": `v0=${hex}`,
            },
        });
    };
}
