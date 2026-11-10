import {
    decodeSessionAccessCredential,
    ProtocolMessageError,
    type SessionAccessClaims,
} from "@morty-build/client/protocol";
import { ProjectAuthenticationError } from "@morty-build/relay-core/contracts";

const SIGNING_SECRET_MINIMUM_LENGTH = 32;
// HKDF binds each key to the protocol purpose and the authenticated AppCredential identity.
const KEY_DERIVATION_LABEL = "morty.session-access.v2:";
const MAXIMUM_LIFETIME_MILLISECONDS = 15 * 60 * 1_000;
const MAXIMUM_ISSUANCE_CLOCK_SKEW_MILLISECONDS = 30_000;
const HMAC_SHA_256 = { hash: "SHA-256", name: "HMAC" } as const;

export class SessionAccessCredentialExpiredError extends ProtocolMessageError {
    constructor(expiredByMilliseconds: number) {
        super(`The Session credential expired ${expiredByMilliseconds} milliseconds ago`);
        this.name = "SessionAccessCredentialExpiredError";
    }
}

function encodeBase64Url(value: Uint8Array): string {
    let binary = "";
    for (const byte of value) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/**
 * Signs and verifies Session credentials with keys only the Relay holds. Each AppCredential's key is derived from the
 * Relay's signing secret, a Worker secret that is never stored with Relay records, so reading the Relay database
 * does not allow forging a Session credential.
 */
export class SessionAccessSigner {
    readonly #secret: string;

    constructor(secret: string) {
        if (typeof secret !== "string" || secret.length < SIGNING_SECRET_MINIMUM_LENGTH) {
            throw new ProjectAuthenticationError(
                "relay_configuration_invalid",
                "The Session credential signing secret is invalid",
            );
        }
        this.#secret = secret;
    }

    /** Non-secret generation fingerprint for invalidating persisted live views after key rotation. Never a signing key. */
    readonly keyId = async (): Promise<string> =>
        encodeBase64Url(
            new Uint8Array(
                await crypto.subtle.digest(
                    "SHA-256",
                    new TextEncoder().encode(`morty.session-access.key-id.v1:${this.#secret}`),
                ),
            ),
        );

    readonly issue = async (publicCredentialId: string, claims: SessionAccessClaims): Promise<string> => {
        const lifetimeMilliseconds = claims.expiresAtEpochMilliseconds - claims.issuedAtEpochMilliseconds;
        if (lifetimeMilliseconds <= 0 || lifetimeMilliseconds > MAXIMUM_LIFETIME_MILLISECONDS) {
            throw new ProtocolMessageError("The Session credential lifetime is invalid");
        }
        const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
        const signedValue = `msession_${publicCredentialId}_${payload}`;
        const signature = await crypto.subtle.sign(
            "HMAC",
            await this.#key(publicCredentialId),
            new TextEncoder().encode(signedValue),
        );
        const credential = `${signedValue}_${encodeBase64Url(new Uint8Array(signature))}`;
        // Issue only a credential that every reader decodes.
        decodeSessionAccessCredential(credential);
        return credential;
    };

    readonly verify = async (credential: string, nowEpochMilliseconds: number): Promise<SessionAccessClaims> => {
        if (!Number.isSafeInteger(nowEpochMilliseconds) || nowEpochMilliseconds < 0) {
            throw new RangeError("The Session credential verification time is invalid");
        }
        const decoded = decodeSessionAccessCredential(credential);
        const valid = await crypto.subtle.verify(
            "HMAC",
            await this.#key(decoded.publicCredentialId),
            decoded.signature,
            new TextEncoder().encode(decoded.signedValue),
        );
        if (!valid) {
            throw new ProtocolMessageError("The Session credential signature is invalid");
        }
        const { expiresAtEpochMilliseconds, issuedAtEpochMilliseconds } = decoded.claims;
        const lifetimeMilliseconds = expiresAtEpochMilliseconds - issuedAtEpochMilliseconds;
        if (lifetimeMilliseconds <= 0 || lifetimeMilliseconds > MAXIMUM_LIFETIME_MILLISECONDS) {
            throw new ProtocolMessageError("The Session credential lifetime is invalid");
        }
        const issuedAheadMilliseconds = issuedAtEpochMilliseconds - nowEpochMilliseconds;
        // Issuance and verification may run on different Worker clocks.
        if (issuedAheadMilliseconds > MAXIMUM_ISSUANCE_CLOCK_SKEW_MILLISECONDS) {
            throw new ProtocolMessageError(
                `The Session credential was issued ${issuedAheadMilliseconds} milliseconds ahead of the verifier`,
            );
        }
        if (expiresAtEpochMilliseconds <= nowEpochMilliseconds) {
            throw new SessionAccessCredentialExpiredError(nowEpochMilliseconds - expiresAtEpochMilliseconds);
        }
        return decoded.claims;
    };

    /** RFC 5869 HKDF-SHA-256, with protocol salt and per-credential context, produces a 256-bit HMAC key. */
    readonly #key = async (publicCredentialId: string): Promise<CryptoKey> => {
        const secret = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.#secret), "HKDF", false, [
            "deriveKey",
        ]);
        return await crypto.subtle.deriveKey(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: new TextEncoder().encode(KEY_DERIVATION_LABEL),
                info: new TextEncoder().encode(publicCredentialId),
            },
            secret,
            { ...HMAC_SHA_256, length: 256 },
            false,
            ["sign", "verify"],
        );
    };
}
