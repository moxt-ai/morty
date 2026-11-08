import { z } from "zod";
import { identifierStringSchema } from "../../shared/identifier.ts";
import { ProtocolMessageError } from "../../shared/message-codec.ts";

const SESSION_ACCESS_PATTERN = /^msession_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]{43})$/u;

const claimsSchema = z
    .object({
        expiresAtEpochMilliseconds: z.number().int().nonnegative(),
        issuedAtEpochMilliseconds: z.number().int().nonnegative(),
        projectId: identifierStringSchema,
        purpose: z.literal("session-access"),
        runtimeId: identifierStringSchema,
        sessionId: identifierStringSchema,
    })
    .readonly();

export type SessionAccessClaims = z.infer<typeof claimsSchema>;

export interface SessionAccessCredential {
    readonly claims: SessionAccessClaims;
    readonly publicCredentialId: string;
    readonly signature: ArrayBuffer;
    readonly signedValue: string;
}

function decodeBase64Url(value: string): Uint8Array {
    try {
        const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
        const binary = atob(padded);
        return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch (cause) {
        throw new ProtocolMessageError("The Session credential is invalid", { cause });
    }
}

function exactBuffer(value: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(value.byteLength);
    new Uint8Array(buffer).set(value);
    return buffer;
}

export function decodeSessionAccessCredential(credential: string): SessionAccessCredential {
    const match = SESSION_ACCESS_PATTERN.exec(credential);
    const publicCredentialId = match?.[1];
    const payload = match?.[2];
    const encodedSignature = match?.[3];
    if (publicCredentialId === undefined || payload === undefined || encodedSignature === undefined) {
        throw new ProtocolMessageError("The Session credential is invalid");
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    } catch (cause) {
        throw new ProtocolMessageError("The Session credential is invalid", { cause });
    }
    const parsed = claimsSchema.safeParse(decoded);
    if (!parsed.success) {
        throw new ProtocolMessageError("The Session credential is invalid", { cause: parsed.error });
    }
    return {
        claims: parsed.data,
        publicCredentialId,
        signature: exactBuffer(decodeBase64Url(encodedSignature)),
        signedValue: `msession_${publicCredentialId}_${payload}`,
    };
}
