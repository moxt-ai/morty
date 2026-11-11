import { z } from "zod";
import { type Identifier, isIdentifier } from "../shared/identifier.ts";

const identifier = z.custom<Identifier>(isIdentifier);
const computerDiagnosticsRequestSchema = z.object({
    kind: z.literal("computer.diagnostics.read"),
    requestId: identifier,
});
const computerDiagnosticsResultSchema = z
    .strictObject({
        kind: z.literal("computer.diagnostics.result"),
        requestId: identifier,
        truncated: z.boolean(),
        version: z.string().max(32),
        entries: z
            .array(z.record(z.string(), z.string().max(256)).readonly())
            .max(200)
            .readonly(),
    })
    .refine((value) => JSON.stringify(value).length <= 65_536, "Diagnostics exceed the report limit");
export type ComputerDiagnosticsRequest = Readonly<z.infer<typeof computerDiagnosticsRequestSchema>>;
export type ComputerDiagnosticsResult = Readonly<z.infer<typeof computerDiagnosticsResultSchema>>;
export const decodeComputerDiagnosticsRequest = (raw: string): ComputerDiagnosticsRequest =>
    computerDiagnosticsRequestSchema.parse(JSON.parse(raw));
export const decodeComputerDiagnosticsResult = (raw: string): ComputerDiagnosticsResult =>
    computerDiagnosticsResultSchema.parse(JSON.parse(raw));
export const encodeComputerDiagnosticsRequest = (value: ComputerDiagnosticsRequest): string =>
    JSON.stringify(computerDiagnosticsRequestSchema.parse(value));
export const encodeComputerDiagnosticsResult = (value: ComputerDiagnosticsResult): string =>
    JSON.stringify(computerDiagnosticsResultSchema.parse(value));
