import type { Session } from "../entity/authentication/session.ts";
import type { ClerkGateway } from "../gateway/clerk-gateway.ts";
import type { ConfigurationStorage } from "../storage/configuration-storage.ts";

type SessionResult =
    | { readonly kind: "authenticated"; readonly session: Session }
    | { readonly kind: "unauthenticated" }
    | { readonly kind: "unavailable" };

export class AuthenticationService {
    private readonly configuration: ConfigurationStorage;
    private readonly clerk: ClerkGateway;

    constructor(cx: {
        readonly storages: { readonly configuration: ConfigurationStorage };
        readonly gateways: { readonly clerk: ClerkGateway };
    }) {
        this.configuration = cx.storages.configuration;
        this.clerk = cx.gateways.clerk;
    }

    readonly publicConfiguration = (): { readonly publishableKey: string } | null => {
        const configuration = this.configuration.read();
        return configuration === null ? null : { publishableKey: configuration.CLERK_PUBLISHABLE_KEY };
    };

    readonly session = async (token: string | undefined, signal: AbortSignal): Promise<SessionResult> => {
        if (token === undefined) {
            return { kind: "unauthenticated" };
        }
        const configuration = this.configuration.read();
        if (configuration === null) {
            return { kind: "unavailable" };
        }
        const session = await this.clerk.verify(token, configuration, signal);
        if (session === null) {
            return { kind: "unauthenticated" };
        }
        return {
            kind: "authenticated",
            session,
        };
    };
}
