import {
    type HumanPrincipal,
    IdentityError,
} from "../../../packages/worker/src/components/slack/service/identity/identity-service.ts";

export class InMemoryHumanIdentity {
    readonly #sessions = new Map<string, string | null>();
    readonly humanToken = async (userId: string | null = "tenant-1"): Promise<string> => {
        const token = crypto.randomUUID();
        this.#sessions.set(token, userId);
        return token;
    };
    readonly authenticateHuman = async (authorization: string | null, signal: AbortSignal): Promise<HumanPrincipal> => {
        signal.throwIfAborted();
        const userId = authorization?.startsWith("Bearer ") ? this.#sessions.get(authorization.slice(7)) : undefined;
        if (userId === undefined) {
            throw new IdentityError("AUTHENTICATION_FAILED", "User session is invalid");
        }
        if (userId === null) {
            throw new IdentityError("AUTHORIZATION_FAILED", "User access is unavailable");
        }
        return { kind: "human", humanId: userId, tenantId: userId };
    };
}
