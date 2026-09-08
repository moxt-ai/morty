import { generateKeyPairSync, sign } from "node:crypto";

export const AUTH_TIME = new Date("2026-09-07T00:00:00.000Z");
export const APP_ORIGIN = "http://localhost:5173";

// A stateful issuer at the signed-token boundary keeps expiry and origin tests
// deterministic without contacting Clerk or replacing the production verifier.
export class IdentityProvider {
    readonly #keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    #sessionNumber = 0;
    readonly publicKey = this.#keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    readonly publishableKey = `pk_test_${Buffer.from("identity.clerk.accounts.dev$").toString("base64url")}`;

    createSession(
        userId: string,
        origin: string = APP_ORIGIN,
        status: "active" | "pending" = "active",
        organizationId: string | null = null,
        organizationRole = "admin",
    ): string {
        this.#sessionNumber += 1;
        const issuedAt = AUTH_TIME.getTime() / 1000;
        const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "local-key" })).toString(
            "base64url",
        );
        const payload = Buffer.from(
            JSON.stringify({
                iss: "https://identity.clerk.accounts.dev",
                sub: userId,
                sid: `sess_${this.#sessionNumber}`,
                azp: origin,
                iat: issuedAt,
                nbf: issuedAt,
                exp: issuedAt + 60,
                v: 2,
                sts: status,
                ...(organizationId === null ? {} : { o: { id: organizationId, rol: organizationRole } }),
            }),
        ).toString("base64url");
        const input = `${header}.${payload}`;
        return `${input}.${sign("RSA-SHA256", Buffer.from(input), this.#keys.privateKey).toString("base64url")}`;
    }
}
