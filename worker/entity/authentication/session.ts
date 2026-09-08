import * as v from "valibot";
import { tenantPlacementSchema } from "../tenant-placement.ts";

export const sessionSchema = v.pipe(
    v.object({
        userId: v.pipe(v.string(), v.minLength(1)),
        sessionId: v.pipe(v.string(), v.minLength(1)),
        organizationId: v.nullable(v.pipe(v.string(), v.minLength(1))),
        placement: v.nullable(tenantPlacementSchema),
    }),
    v.readonly(),
);

export type Session = v.InferOutput<typeof sessionSchema>;
