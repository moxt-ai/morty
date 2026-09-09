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
export type MobiusPairing = Readonly<v.InferOutput<typeof pairingSchema>> & { readonly relayUrl: string };
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
            throw new MobiusManagementError("TENANT_MISMATCH", "Pairing belongs to another workspace.");
        }
        this.storage.setItem(
            `mobius:channel-credential:${v.parse(identifier, value.channelId)}`,
            JSON.stringify(credential),
        );
    };
    readonly read = (projectId: string): string | null => {
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
                    return parsed.output.hostToken;
                }
            } catch {
                /* A malformed unrelated credential must not hide valid access. */
            }
        }
        return null;
    };
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
export class NativeMobiusRequests implements MobiusBotsRequests {
    readonly origin: string;
    readonly credentials: ProjectOwnerCredentials;
    readonly getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly fetchRequest: (request: Request) => Promise<Response>;
    constructor(
        origin: string,
        credentials: ProjectOwnerCredentials,
        getToken: (signal: AbortSignal) => Promise<string | null>,
        fetchRequest: (request: Request) => Promise<Response> = (request) => fetch(request),
    ) {
        this.origin = origin;
        this.credentials = credentials;
        this.getToken = getToken;
        this.fetchRequest = fetchRequest;
    }
    readonly #request = async (
        path: string,
        signal: AbortSignal,
        token: string | null,
        body?: object,
    ): Promise<unknown> => {
        const response = await this.fetchRequest(
            new Request(new URL(`/mobius/api${path}`, this.origin), {
                method: body === undefined ? "GET" : "POST",
                signal,
                headers: {
                    ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
        );
        const value: unknown = await response.json();
        signal.throwIfAborted();
        if (!response.ok) {
            const error = v.safeParse(v.object({ error: v.object({ code: v.string(), message: v.string() }) }), value);
            throw new MobiusManagementError(
                error.success ? error.output.error.code : "MOBIUS_UNAVAILABLE",
                error.success ? error.output.error.message : "Mobius is temporarily unavailable.",
            );
        }
        return value;
    };
    readonly #deadline = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    readonly canManageProject = (projectId: string) => this.credentials.read(projectId) !== null;
    readonly listProjects = async (parent: AbortSignal) => {
        const signal = this.#deadline(parent);
        return v.parse(
            v.object({ projects: v.array(projectSchema) }),
            await this.#request("/v1/projects", signal, await this.getToken(signal)),
        ).projects;
    };
    readonly listBots = async (projectId: string, parent: AbortSignal) => {
        const signal = this.#deadline(parent);
        return v.parse(
            v.object({ bots: v.array(botSchema) }),
            await this.#request(
                `/v1/projects/${v.parse(identifier, projectId)}/bots`,
                signal,
                await this.getToken(signal),
            ),
        ).bots;
    };
    readonly projectStatus = async (projectId: string, parent: AbortSignal) => {
        const signal = this.#deadline(parent);
        return v.parse(
            v.object({ status: v.picklist(["connected", "offline"]) }),
            await this.#request(
                `/v1/projects/${v.parse(identifier, projectId)}/status`,
                signal,
                await this.getToken(signal),
            ),
        ).status;
    };
    readonly createPairing = async (parent: AbortSignal) => {
        const signal = this.#deadline(parent);
        const value = await this.#request("/pairings", signal, await this.getToken(signal), {});
        const credential = v.parse(
            v.object({ channelId: identifier, projectId: identifier, tenantId: identifier, hostToken: v.string() }),
            value,
        );
        this.credentials.save(credential);
        return { ...v.parse(pairingSchema, value), relayUrl: this.origin };
    };
    readonly pairingStatus = async (pairing: MobiusPairing, parent: AbortSignal) =>
        v.parse(
            v.object({ status: v.picklist(["pending", "paired", "expired"]) }),
            await this.#request(
                `/pairings/${v.parse(identifier, pairing.pairingId)}?token=${encodeURIComponent(pairing.pollToken)}`,
                this.#deadline(parent),
                null,
            ),
        ).status;
    readonly createBot = async (
        projectId: string,
        input: { readonly displayName: string; readonly description: string },
        parent: AbortSignal,
    ) =>
        v.parse(
            botSchema,
            await this.#request(
                `/v1/projects/${v.parse(identifier, projectId)}/bots`,
                this.#deadline(parent),
                this.credentials.require(projectId),
                { ...input, avatarRef: "" },
            ),
        );
    readonly getBotSetup = async (projectId: string, botId: string, parent: AbortSignal): Promise<BotSetup> => {
        const signal = this.#deadline(parent);
        const token = this.credentials.require(projectId);
        const [setup, runtimes] = await Promise.all([
            this.#request(`/v1/bots/${v.parse(identifier, botId)}/setup`, signal, token),
            this.#request(`/projects/${v.parse(identifier, projectId)}/runtimes`, signal, token),
        ]);
        return {
            ...v.parse(setupSchema, setup),
            runtimes: v.parse(v.object({ runtimes: v.array(runtimeSchema) }), runtimes).runtimes,
        };
    };
    readonly configureBot = async (projectId: string, botId: string, input: BotSetupInput, parent: AbortSignal) => {
        const signal = this.#deadline(parent);
        const token = this.credentials.require(projectId);
        const path = `/v1/bots/${v.parse(identifier, botId)}`;
        const current = v.parse(
            v.object({
                lifecycleRevision: v.number(),
                behaviorRevision: v.number(),
                configuration: v.union([
                    v.object({ kind: v.literal("not-configured") }),
                    v.object({
                        kind: v.picklist(["requested", "approved", "unavailable", "revoked"]),
                        allowedDeliveryTargetIds: v.array(identifier),
                        completionPolicy: v.record(v.string(), v.unknown()),
                    }),
                ]),
            }),
            await this.#request(`${path}/setup`, signal, token),
        );
        if (
            current.lifecycleRevision !== input.lifecycleRevision ||
            current.behaviorRevision !== input.behaviorRevision ||
            current.configuration.kind === "requested"
        ) {
            throw new MobiusManagementError("SETUP_CHANGED", "Refresh setup before saving again.");
        }
        const behavior = v.parse(
            v.object({ behaviorRevisionId: identifier }),
            await this.#request(`${path}/behavior-revisions`, signal, token, {
                expectedRevision: input.behaviorRevision,
                instructions: input.instructions,
                requiredCapabilities: input.instructions.trim() ? ["embedded-context"] : [],
                agentConfiguration: {},
            }),
        );
        await this.#request(`${path}/execution-bindings`, signal, token, {
            expectedRevision: input.lifecycleRevision,
            behaviorRevisionId: behavior.behaviorRevisionId,
            runtimeId: input.runtimeId,
            agentRef: input.agentRef,
            workspaceRef: input.workspaceRef,
            agentConfigRevision: 1,
            allowedDeliveryTargetIds:
                current.configuration.kind === "not-configured" ? [] : current.configuration.allowedDeliveryTargetIds,
            completionPolicy:
                current.configuration.kind === "not-configured"
                    ? { kind: "none" }
                    : current.configuration.completionPolicy,
        });
        return this.getBotSetup(projectId, botId, signal);
    };
}
