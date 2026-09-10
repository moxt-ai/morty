import * as v from "valibot";
export const clerkSessionSchema = v.pipe(
    v.object({
        userId: v.pipe(v.string(), v.minLength(1)),
        sessionId: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
);

export type ClerkSession = v.InferOutput<typeof clerkSessionSchema>;

export type Session =
    | {
          readonly authentication: { readonly kind: "anonymous" };
          readonly userId: string;
      }
    | {
          readonly authentication: { readonly kind: "clerk" };
          readonly sessionId: string;
          readonly userId: string;
      };
