import {
    decodeSessionAccessCredential,
    ProtocolMessageError,
    type SessionAccessClaims,
} from "@morty-build/client/protocol";
import { ProjectAuthenticationError } from "@morty-build/relay-core";

const SIGNING_SECRET_MINIMUM_LENGTH = 32;
// Domain-separates the per-AppCredential keys derived from the Relay's signing secret.
const KEY_DERIVATION_LABEL = "morty.session-access.v1:";
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
 * Relay's signing secret, a Worker secret that is never stored with Platform records, so reading the Platform database
 * does not allow forging a Session credential.
 */
export class SessionAccessSigner {
    readonly #secret: string;

    constructor(secret: string) {
        this.#secret = secret;
    }

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
        // ProjectDO issues credentials that RuntimeRelay verifies using an independent Worker clock.
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

    /** The AppCredential's key: HMAC-SHA-256 of its public identifier under the Relay's signing secret. */
    readonly #key = async (publicCredentialId: string): Promise<CryptoKey> => {
        if (this.#secret.length < SIGNING_SECRET_MINIMUM_LENGTH) {
            throw new ProjectAuthenticationError(
                "relay_configuration_invalid",
                "The Session credential signing secret is invalid",
            );
        }
        const secret = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(this.#secret),
            HMAC_SHA_256,
            false,
            ["sign"],
        );
        const derived = await crypto.subtle.sign(
            "HMAC",
            secret,
            new TextEncoder().encode(`${KEY_DERIVATION_LABEL}${publicCredentialId}`),
        );
        return await crypto.subtle.importKey("raw", derived, HMAC_SHA_256, false, ["sign", "verify"]);
    };
}
