import { json } from "../infra/http.ts";
import type { AuthenticationService } from "../service/authentication-service.ts";

function unavailable(): Response {
    return json({ error: { code: "AUTH_UNAVAILABLE", message: "Sign-in is temporarily unavailable." } }, 503);
}

export class AuthenticationController {
    static readonly inject = ["authenticationService"] as const;

    private readonly authentication: AuthenticationService;

    constructor(authentication: AuthenticationService) {
        this.authentication = authentication;
    }

    readonly fetch = async (request: Request): Promise<Response> => {
        if (request.method !== "GET") {
            return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } }, 405, {
                Allow: "GET",
            });
        }
        if (new URL(request.url).pathname === "/mobius-cloud/api/config") {
            const configuration = this.authentication.publicConfiguration();
            return configuration === null ? unavailable() : json(configuration);
        }
        const token = request.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
        const result = await this.authentication.session(token, request.signal);
        switch (result.kind) {
            case "authenticated":
                return json(result.session);
            case "unauthenticated":
                return json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401);
            case "unavailable":
                return unavailable();
        }
    };
}
