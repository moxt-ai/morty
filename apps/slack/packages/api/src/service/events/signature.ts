const encoder = new TextEncoder();
const MAX_REQUEST_AGE_SECONDS = 5 * 60;

export type SlackSignatureResult =
    | { readonly valid: true }
    | {
          readonly code: "INVALID_SIGNATURE" | "INVALID_TIMESTAMP";
          readonly valid: false;
      };

export interface SlackSignatureInput {
    readonly body: string;
    readonly nowEpochSeconds: number;
    readonly signature: string;
    readonly signingSecret: string;
    readonly timestamp: string;
}

export async function verifySlackSignature(
    input: SlackSignatureInput,
    signal: AbortSignal,
): Promise<SlackSignatureResult> {
    signal.throwIfAborted();
    const timestamp = Number.parseInt(input.timestamp, 10);
    if (!Number.isSafeInteger(timestamp) || Math.abs(input.nowEpochSeconds - timestamp) > MAX_REQUEST_AGE_SECONDS) {
        return { code: "INVALID_TIMESTAMP", valid: false };
    }

    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(input.signingSecret),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
    );
    signal.throwIfAborted();
    const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${input.timestamp}:${input.body}`));
    signal.throwIfAborted();
    const expected = `v0=${toHex(new Uint8Array(digest))}`;

    return constantTimeEqual(expected, input.signature) ? { valid: true } : { code: "INVALID_SIGNATURE", valid: false };
}

function constantTimeEqual(expected: string, received: string): boolean {
    if (expected.length !== received.length) {
        return false;
    }
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
        difference |= expected.charCodeAt(index) ^ received.charCodeAt(index);
    }
    return difference === 0;
}

function toHex(bytes: Uint8Array): string {
    let result = "";
    for (const byte of bytes) {
        result += byte.toString(16).padStart(2, "0");
    }
    return result;
}
