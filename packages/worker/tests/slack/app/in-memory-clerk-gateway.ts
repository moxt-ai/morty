import type { Session } from "../../../src/components/management/entity/authentication/session.ts";
import type { AuthenticationConfiguration } from "../../../src/components/management/storage/authentication-configuration.ts";

export class InMemoryClerkGateway {
    readonly #sessions = new Map<string, string>();
    readonly humanToken = async (userId = "tenant-1"): Promise<string> => {
        const token = crypto.randomUUID();
        this.#sessions.set(token, userId);
        return token;
    };
    readonly verify = async (
        token: string,
        _configuration: AuthenticationConfiguration,
        signal: AbortSignal,
    ): Promise<Session | null> => {
        signal.throwIfAborted();
        const userId = this.#sessions.get(token);
        return userId === undefined ? null : { sessionId: "sess_test", userId };
    };
}
