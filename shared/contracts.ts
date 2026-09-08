import * as v from "valibot";

export const publishableKeySchema = v.pipe(v.string(), v.regex(/^pk_(test|live)_[A-Za-z0-9_-]+$/u));
export const sessionSchema = v.pipe(
    v.object({
        userId: v.pipe(v.string(), v.minLength(1)),
        sessionId: v.pipe(v.string(), v.minLength(1)),
        organizationId: v.nullable(v.pipe(v.string(), v.minLength(1))),
    }),
    v.readonly(),
);
