import { IdentityError } from "../service/identity/identity-service";

export class IdentityGateway {
    readonly #serviceToken: string;
    constructor(cx: { readonly config: { readonly serviceToken: string } }) {
        const { serviceToken } = cx.config;
        this.#serviceToken = serviceToken;
    }

    readonly request = async (url: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
        signal.throwIfAborted();
        const response = await fetch(url, {
            body: JSON.stringify(body),
            headers: {
                Authorization: `Bearer ${this.#serviceToken}`,
                "Content-Type": "application/json",
            },
            method: "POST",
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
        if (response.status === 401 || response.status === 403) {
            throw new IdentityError("AUTHENTICATION_FAILED", "Credential was rejected");
        }
        if (!response.ok) {
            throw new IdentityError("AUTHENTICATION_FAILED", "Identity provider is unavailable");
        }
        return await response.json();
    };
}
