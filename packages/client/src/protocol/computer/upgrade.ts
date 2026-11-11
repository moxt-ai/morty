import { z } from "zod";
import { type Identifier, isIdentifier } from "../shared/identifier.ts";

// Only exact releases of the fixed Morty npm package are supported.
const computerUpgradeVersionSchema = z
    .string()
    .max(128)
    .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/);
export const decodeComputerUpgradeVersion = (value: unknown): string => computerUpgradeVersionSchema.parse(value);
const computerUpgradeResultSchema = z
    .strictObject({
        kind: z.literal("computer.upgrade.result"),
        requestId: z.custom<Identifier>(isIdentifier),
        version: computerUpgradeVersionSchema,
        targetVersion: computerUpgradeVersionSchema,
        outcome: z
            .discriminatedUnion("status", [
                z.strictObject({ status: z.literal("accepted") }),
                z.strictObject({ status: z.literal("succeeded") }),
                z.strictObject({
                    status: z.literal("failed"),
                    stdout: z.string().max(4096).optional(),
                    stderr: z.string().max(4096).optional(),
                    code: z.string().min(1).max(64),
                    message: z.string().max(256),
                    retryAfter: z.number().int().nonnegative(),
                }),
                z.strictObject({
                    status: z.literal("rejected"),
                    code: z.string().min(1).max(64),
                    message: z.string().max(256),
                    retryAfter: z.number().int().nonnegative(),
                }),
            ])
            .readonly(),
    })
    .readonly();
export type ComputerUpgradeResult = z.infer<typeof computerUpgradeResultSchema>;
export const decodeComputerUpgradeResult = (raw: string): ComputerUpgradeResult =>
    computerUpgradeResultSchema.parse(JSON.parse(raw));
export const encodeComputerUpgradeResult = (value: ComputerUpgradeResult): string =>
    JSON.stringify(computerUpgradeResultSchema.parse(value));
