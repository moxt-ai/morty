import { decodeIdentifier, type Identifier, isIdentifier } from "@moxt-ai/mobius-protocol";
import * as v from "valibot";

const identifier = v.custom<Identifier>(isIdentifier);
const botSchema = v.pipe(
    v.object({ botId: identifier, displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(80)) }),
    v.readonly(),
);

export type ManagedBot = v.InferOutput<typeof botSchema>;
const managedBotDetailSchema = v.pipe(
    v.object({
        botId: identifier,
        displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
        configured: v.boolean(),
        instructions: v.pipe(v.string(), v.maxLength(100000)),
    }),
    v.readonly(),
);
export type ManagedBotDetail = v.InferOutput<typeof managedBotDetailSchema>;
const projectSchema = v.pipe(
    v.object({ projectId: identifier, displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(120)) }),
    v.readonly(),
);
export type ManagedProject = v.InferOutput<typeof projectSchema>;

export interface ManagementApiOptions {
    readonly projectId: string;
    readonly fetchRequest: (request: Request) => Promise<Response>;
    readonly getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly origin: string;
}

export class ManagementApi {
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly #origin: string;
    readonly #projectId: Identifier;
    constructor(options: ManagementApiOptions) {
        this.#fetchRequest = options.fetchRequest;
        this.#getToken = options.getToken;
        this.#origin = options.origin;
        this.#projectId = decodeIdentifier(options.projectId);
    }

    readonly listBots = async (signal: AbortSignal): Promise<readonly ManagedBot[]> =>
        v.parse(v.object({ bots: v.array(botSchema) }), await this.#request("/bots", "GET", undefined, signal)).bots;

    readonly readProject = async (signal: AbortSignal): Promise<ManagedProject | null> =>
        v.parse(
            v.object({ project: v.nullable(projectSchema) }),
            await this.#request("/project", "GET", undefined, signal),
        ).project;

    readonly createProject = async (displayName: string, signal: AbortSignal): Promise<ManagedProject> =>
        v.parse(v.object({ project: projectSchema }), await this.#request("/project", "POST", { displayName }, signal))
            .project;

    readonly createBot = async (displayName: string, signal: AbortSignal): Promise<ManagedBot> =>
        v.parse(botSchema, await this.#request("/bots", "POST", { displayName }, signal));

    readonly deleteBot = async (botId: string, signal: AbortSignal): Promise<void> => {
        await this.#request(`/bots/${encodeURIComponent(decodeIdentifier(botId))}`, "DELETE", undefined, signal);
    };

    readonly readBot = async (botId: string, signal: AbortSignal): Promise<ManagedBotDetail> =>
        v.parse(
            managedBotDetailSchema,
            await this.#request(`/bots/${encodeURIComponent(decodeIdentifier(botId))}`, "GET", undefined, signal),
        );

    readonly updateBot = async (
        botId: string,
        input: { readonly displayName: string; readonly instructions: string },
        signal: AbortSignal,
    ): Promise<ManagedBotDetail> =>
        v.parse(
            managedBotDetailSchema,
            await this.#request(`/bots/${encodeURIComponent(decodeIdentifier(botId))}`, "PATCH", input, signal),
        );

    readonly #request = async (
        path: string,
        method: "DELETE" | "GET" | "PATCH" | "POST",
        body: object | undefined,
        requestSignal: AbortSignal,
    ): Promise<unknown> => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Sign in to continue.");
        }
        const response = await this.#fetchRequest(
            new Request(
                new URL(`/morty/api/projects/${encodeURIComponent(this.#projectId)}/management${path}`, this.#origin),
                {
                    method,
                    signal,
                    headers: {
                        authorization: `Bearer ${token}`,
                        ...(body === undefined ? {} : { "content-type": "application/json" }),
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                },
            ),
        );
        const value: unknown = response.status === 204 ? null : await response.json();
        signal.throwIfAborted();
        if (!response.ok) {
            const parsed = v.safeParse(v.object({ error: v.object({ code: v.string(), message: v.string() }) }), value);
            throw new CloudApiError(
                parsed.success ? parsed.output.error.code : "MANAGEMENT_UNAVAILABLE",
                parsed.success ? parsed.output.error.message : "Machine management is unavailable.",
                response.status,
                response.headers.get("x-morty-request-id") ?? response.headers.get("x-request-id") ?? "",
            );
        }
        return value;
    };
}

export class CloudApiError extends Error {
    readonly code: string;
    readonly status: number | null;
    readonly requestId: string;
    constructor(code: string, message: string, status: number | null = null, requestId = "") {
        super(message);
        this.code = code;
        this.status = status;
        this.requestId = requestId;
        this.name = "CloudApiError";
    }
}

const runtimeConnectionCodes = new Set(["connection_closed", "runtime_offline"]);

export function isRuntimeConnectionFailure(cause: unknown): boolean {
    return cause instanceof CloudApiError && runtimeConnectionCodes.has(cause.code.toLowerCase());
}
