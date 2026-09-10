class SecretCipherError extends Error {
    readonly code: "INVALID_ENCRYPTION_KEY" | "INVALID_ENCRYPTED_SECRET";

    constructor(code: "INVALID_ENCRYPTION_KEY" | "INVALID_ENCRYPTED_SECRET", message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "SecretCipherError";
        this.code = code;
    }
}

export class SecretCipher {
    readonly #encodedKey: string;

    constructor(encodedKey: string) {
        this.#encodedKey = encodedKey;
    }

    readonly encrypt = async (plaintext: string, signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
            { iv, name: "AES-GCM" },
            await this.#key(["encrypt"]),
            new TextEncoder().encode(plaintext),
        );
        signal.throwIfAborted();
        return `v1.${encodeBase64(iv)}.${encodeBase64(new Uint8Array(ciphertext))}`;
    };

    readonly decrypt = async (encrypted: string, signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        const [version, encodedIv, encodedCiphertext, unexpected] = encrypted.split(".");
        if (
            version !== "v1" ||
            encodedIv === undefined ||
            encodedCiphertext === undefined ||
            unexpected !== undefined
        ) {
            throw new SecretCipherError("INVALID_ENCRYPTED_SECRET", "Encrypted secret has an invalid format");
        }
        try {
            const plaintext = await crypto.subtle.decrypt(
                { iv: decodeBase64(encodedIv), name: "AES-GCM" },
                await this.#key(["decrypt"]),
                decodeBase64(encodedCiphertext),
            );
            signal.throwIfAborted();
            return new TextDecoder().decode(plaintext);
        } catch (error) {
            if (error instanceof SecretCipherError) {
                throw error;
            }
            throw new SecretCipherError("INVALID_ENCRYPTED_SECRET", "Encrypted secret could not be decrypted", {
                cause: error,
            });
        }
    };

    readonly #key = async (usages: Array<"decrypt" | "encrypt">): Promise<CryptoKey> => {
        const bytes = decodeBase64(this.#encodedKey);
        if (bytes.byteLength !== 32) {
            throw new SecretCipherError("INVALID_ENCRYPTION_KEY", "SLACK_TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
        }
        return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, usages);
    };
}

function encodeBase64(value: Uint8Array): string {
    let binary = "";
    for (const byte of value) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function decodeBase64(value: string): ArrayBuffer {
    try {
        const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        return buffer;
    } catch (error) {
        throw new SecretCipherError("INVALID_ENCRYPTED_SECRET", "Secret contains invalid base64", { cause: error });
    }
}
