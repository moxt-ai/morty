import { z } from "zod";
import { identifierStringSchema } from "../../shared/identifier.ts";
import { decodeZodValue } from "../../shared/message-codec.ts";

/** An Agent owns its native identity; another harness may use the same value. */
export const nativeSessionTargetSchema = z
    .strictObject({
        harness: identifierStringSchema,
        sessionId: identifierStringSchema,
    })
    .readonly();

export type NativeSessionTarget = z.infer<typeof nativeSessionTargetSchema>;

export const decodeNativeSessionTarget = (value: unknown): NativeSessionTarget =>
    decodeZodValue(value, nativeSessionTargetSchema);

export function readNativeSessionTarget(value: unknown): NativeSessionTarget | null {
    const result = nativeSessionTargetSchema.safeParse(value);
    return result.success ? result.data : null;
}
