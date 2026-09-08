import * as v from "valibot";

const publishableKeySchema = v.pipe(v.string(), v.regex(/^pk_(test|live)_[A-Za-z0-9_-]+$/u));

export const configurationSchema = v.pipe(
    v.object({
        CLERK_PUBLISHABLE_KEY: publishableKeySchema,
        CLERK_JWT_KEY: v.pipe(v.string(), v.startsWith("-----BEGIN PUBLIC KEY-----")),
        APP_ORIGIN: v.pipe(
            v.string(),
            v.url(),
            v.check((value) => {
                const url = new URL(value);
                return ["http:", "https:"].includes(url.protocol) && url.origin === value;
            }),
        ),
    }),
    v.readonly(),
);

export type AuthenticationConfiguration = v.InferOutput<typeof configurationSchema>;
