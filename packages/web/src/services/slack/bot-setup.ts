import * as v from "valibot";

const configurationSchema = v.union([
    v.object({ kind: v.literal("not-configured") }),
    v.object({
        kind: v.picklist(["requested", "approved", "unavailable", "revoked"]),
        runtimeId: v.string(),
        agentRef: v.string(),
        workspaceRef: v.string(),
        instructions: v.string(),
    }),
]);
export const botSetupSchema = v.pipe(
    v.object({
        lifecycle: v.string(),
        lifecycleRevision: v.number(),
        behaviorRevision: v.number(),
        configuration: configurationSchema,
        runtimes: v.array(
            v.object({
                runtimeId: v.string(),
                machineName: v.string(),
                workspaceName: v.string(),
                online: v.boolean(),
                agents: v.array(v.object({ id: v.string(), label: v.string() })),
            }),
        ),
    }),
    v.readonly(),
);
export type BotSetup = v.InferOutput<typeof botSetupSchema>;
export interface BotSetupInput {
    readonly runtimeId: string;
    readonly agentRef: string;
    readonly workspaceRef: string;
    readonly instructions: string;
    readonly lifecycleRevision: number;
    readonly behaviorRevision: number;
}
