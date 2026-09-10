import type { ApplicationContext } from "../../../composition/application-context.ts";
import { json } from "../../../infra/http.ts";
import type { Session } from "../entity/authentication/session.ts";

export async function authenticatedSession(context: ApplicationContext, request: Request): Promise<Session | Response> {
    const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/iu)?.[1];
    const result = await context.services.authentication.session(token, request.signal);
    switch (result.kind) {
        case "authenticated":
            return result.session;
        case "unauthenticated":
            return json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401);
        case "unavailable":
            return json({ error: { code: "AUTH_UNAVAILABLE", message: "Sign-in is temporarily unavailable." } }, 503);
    }
}
