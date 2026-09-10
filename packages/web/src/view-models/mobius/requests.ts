import * as v from "valibot";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]+$/u));
const projectSchema = v.object({ projectId: identifier, displayName: v.string() });
const botSchema = v.object({
    botId: identifier,
    displayName: v.string(),
    lifecycle: v.string(),
    setupStatus: v.optional(v.picklist(["not-configured", "requested", "approved", "unavailable", "revoked"])),
});
const pairingSchema = v.object({
    pairingId: identifier,
    projectId: identifier,
    pairingCode: v.string(),
    pollToken: v.string(),
    expiresAt: v.string(),
});
const credentialSchema = v.object({
    authority: v.literal("owner"),
    projectId: identifier,
    tenantId: identifier,
    hostToken: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{32,256}$/u)),
});
const configuredSchema = v.object({
    kind: v.picklist(["requested", "approved", "unavailable", "revoked"]),
    runtimeId: identifier,
    agentRef: identifier,
    workspaceRef: v.string(),
    instructions: v.string(),
});
const setupSchema = v.object({
    lifecycle: v.string(),
    lifecycleRevision: v.number(),
    behaviorRevision: v.number(),
    configuration: v.union([v.object({ kind: v.literal("not-configured") }), configuredSchema]),
});
const runtimeSchema = v.object({
    runtimeId: identifier,
    machineName: v.string(),
    workspaceName: v.string(),
    online: v.boolean(),
    agents: v.array(v.object({ id: identifier, label: v.string() })),
});
export type ManagedMobiusBot = Readonly<v.InferOutput<typeof botSchema>>;
export type MobiusProject = Readonly<v.InferOutput<typeof projectSchema>>;
type MobiusPairing = Readonly<v.InferOutput<typeof pairingSchema>> & { readonly relayUrl: string };
export type BotSetup = Readonly<v.InferOutput<typeof setupSchema>> & {
    readonly runtimes: readonly v.InferOutput<typeof runtimeSchema>[];
};
export interface BotSetupInput {
    readonly runtimeId: string;
    readonly agentRef: string;
    readonly workspaceRef: string;
    readonly instructions: string;
    readonly lifecycleRevision: number;
    readonly behaviorRevision: number;
}
export interface MobiusBotsRequests {
    readonly listProjects: (signal: AbortSignal) => Promise<readonly MobiusProject[]>;
    readonly listBots: (projectId: string, signal: AbortSignal) => Promise<readonly ManagedMobiusBot[]>;
    readonly projectStatus: (projectId: string, signal: AbortSignal) => Promise<"connected" | "offline">;
    readonly canManageProject: (projectId: string) => boolean;
    readonly createPairing: (signal: AbortSignal) => Promise<MobiusPairing>;
    readonly pairingStatus: (pairing: MobiusPairing, signal: AbortSignal) => Promise<"pending" | "paired" | "expired">;
    readonly createBot: (
        projectId: string,
        input: { readonly displayName: string; readonly description: string },
        signal: AbortSignal,
    ) => Promise<ManagedMobiusBot>;
    readonly getBotSetup: (projectId: string, botId: string, signal: AbortSignal) => Promise<BotSetup>;
    readonly configureBot: (
        projectId: string,
        botId: string,
        input: BotSetupInput,
        signal: AbortSignal,
    ) => Promise<BotSetup>;
}
class MobiusManagementError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.code = code;
        this.name = "MobiusManagementError";
    }
}
export class ProjectOwnerCredentials {
    readonly tenantId: string;
    readonly storage: Storage;
    constructor(tenantId: string, storage: Storage) {
        this.tenantId = tenantId;
        this.storage = storage;
    }
    readonly save = (value: {
        readonly projectId: string;
        readonly channelId: string;
        readonly tenantId: string;
        readonly hostToken: string;
    }) => {
        const credential = v.parse(credentialSchema, { ...value, authority: "owner" });
        if (credential.tenantId !== this.tenantId) {
            throw new MobiusManagementError("TENANT_MISMATCH", "Pairing belongs to another user.");
        }
        this.storage.setItem(
            `mobius:channel-credential:${v.parse(identifier, value.channelId)}`,
            JSON.stringify(credential),
        );
    };
    readonly #readAccess = (projectId: string): { readonly hostToken: string; readonly channelId: string } | null => {
        for (let index = 0; index < this.storage.length; index++) {
            const key = this.storage.key(index);
            if (!key?.startsWith("mobius:channel-credential:")) {
                continue;
            }
            try {
                const value: unknown = JSON.parse(this.storage.getItem(key) ?? "null");
                const parsed = v.safeParse(credentialSchema, value);
                if (
                    parsed.success &&
                    parsed.output.tenantId === this.tenantId &&
                    parsed.output.projectId === projectId
                ) {
                    return {
                        hostToken: parsed.output.hostToken,
                        channelId: v.parse(identifier, key.slice("mobius:channel-credential:".length)),
                    };
                }
            } catch {
                /* A malformed unrelated credential must not hide valid access. */
            }
        }
        return null;
    };
    readonly read = (projectId: string) => this.#readAccess(projectId)?.hostToken ?? null;
    readonly channel = (projectId: string) => this.#readAccess(projectId)?.channelId ?? null;
    readonly require = (projectId: string) => {
        const token = this.read(projectId);
        if (token === null) {
            throw new MobiusManagementError(
                "OWNER_ACCESS_REQUIRED",
                "Pair this project in this browser to manage its bots.",
            );
        }
        return token;
    };
}
