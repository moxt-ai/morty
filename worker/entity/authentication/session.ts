import * as v from "valibot";

export const sessionSchema = v.pipe(
    v.object({
        userId: v.pipe(v.string(), v.minLength(1)),
        sessionId: v.pipe(v.string(), v.minLength(1)),
        organizationId: v.nullable(v.pipe(v.string(), v.minLength(1))),
    }),
    v.readonly(),
);

export type Session = v.InferOutput<typeof sessionSchema>;
