import { z } from "zod";

export const publicConfigSchema = z
  .object({
    publishableKey: z.string().regex(/^pk_(test|live)_[A-Za-z0-9_-]+$/),
  })
  .readonly();

export const sessionSchema = z
  .object({
    userId: z.string().min(1),
    sessionId: z.string().min(1),
    organizationId: z.string().min(1).nullable(),
  })
  .readonly();
