import { verifyToken } from "@clerk/backend";
import * as v from "valibot";
import { type Session, sessionSchema } from "../components/management/entity/authentication/session.ts";
import type { AuthenticationConfiguration } from "../components/management/storage/authentication-configuration.ts";

const claimsSchema = v.pipe(
    v.object({
        sub: v.pipe(v.string(), v.startsWith("user_")),
        sid: v.pipe(v.string(), v.startsWith("sess_")),
        sts: v.optional(v.picklist(["active", "pending"])),
    }),
    v.readonly(),
);

export class ClerkGateway {
    readonly verify = async (
        token: string,
        configuration: AuthenticationConfiguration,
        signal: AbortSignal,
    ): Promise<Session | null> => {
        signal.throwIfAborted();
        let verified: unknown;
        try {
            verified = await verifyToken(token, {
                jwtKey: configuration.CLERK_JWT_KEY,
                authorizedParties: [configuration.APP_ORIGIN],
            });
        } catch {
            signal.throwIfAborted();
            return null;
        }
        signal.throwIfAborted();
        const claims = v.safeParse(claimsSchema, verified);
        if (!claims.success || claims.output.sts === "pending") {
            return null;
        }
        return v.parse(sessionSchema, {
            userId: claims.output.sub,
            sessionId: claims.output.sid,
        });
    };
}
