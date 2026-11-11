import { z } from "zod";

const lifecycleResponse = z
    .discriminatedUnion("kind", [
        z.strictObject({
            kind: z.literal("status"),
            protocolVersion: z.literal(3),
            daemon: z.strictObject({ pid: z.number().int().positive(), version: z.string() }).readonly(),
        }),
        z.strictObject({ kind: z.literal("stopped") }),
        z.strictObject({ kind: z.literal("error"), code: z.string(), message: z.string() }),
    ])
    .readonly();
export type LifecycleResponse = z.infer<typeof lifecycleResponse>;

export function decodeLifecycleResponse(value: unknown): LifecycleResponse {
    return lifecycleResponse.parse(value);
}
