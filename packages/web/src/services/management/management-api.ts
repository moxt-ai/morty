import { decodeIdentifier, type Identifier, isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";

const identifier = v.custom<Identifier>(isIdentifier);
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
const runtimeBindingSchema = v.object({ botId: identifier, runtimeId: v.nullable(identifier) });

/** Whether the Worker binds the Machine to a Runtime. The Worker's record is the only source of this fact. */
export type RuntimeBinding = { readonly kind: "unbound" } | { readonly kind: "bound"; readonly runtimeId: Identifier };

/** The Machine's Runtime binding resource, read by setup and the page and watched through the Chat bridge. */
export function runtimeBindingUrl(origin: string, projectId: string, botId: string): URL {
    return managementUrl(
        origin,
        decodeIdentifier(projectId),
        `/bots/${encodeURIComponent(decodeIdentifier(botId))}/runtime-binding`,
    );
}

function managementUrl(origin: string, projectId: Identifier, path: string): URL {
    return new URL(`/morty/api/projects/${encodeURIComponent(projectId)}/management${path}`, origin);
}

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

    readonly readProject = async (signal: AbortSignal): Promise<ManagedProject | null> =>
        v.parse(
            v.object({ project: v.nullable(projectSchema) }),
            await this.#request("/project", "GET", undefined, signal),
        ).project;

    readonly readBot = async (botId: string, signal: AbortSignal): Promise<ManagedBotDetail> =>
        v.parse(
            managedBotDetailSchema,
            await this.#request(`/bots/${encodeURIComponent(decodeIdentifier(botId))}`, "GET", undefined, signal),
        );

    readonly readRuntimeBinding = async (botId: string, signal: AbortSignal): Promise<RuntimeBinding> => {
        const requestedBotId = decodeIdentifier(botId);
        const binding = v.parse(
            runtimeBindingSchema,
            await this.#request(
                `/bots/${encodeURIComponent(requestedBotId)}/runtime-binding`,
                "GET",
                undefined,
                signal,
            ),
        );
        if (binding.botId !== requestedBotId) {
            throw new CloudApiError("INVALID_RESPONSE", "Chat management returned another Machine.");
        }
        return binding.runtimeId === null ? { kind: "unbound" } : { kind: "bound", runtimeId: binding.runtimeId };
    };

    readonly #request = async (
        path: string,
        method: "GET" | "POST",
        body: object | undefined,
        requestSignal: AbortSignal,
    ): Promise<unknown> => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Sign in to continue.");
        }
        const response = await this.#fetchRequest(
            new Request(managementUrl(this.#origin, this.#projectId, path), {
                method,
                signal,
                headers: {
                    authorization: `Bearer ${token}`,
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
        );
        const value: unknown = response.status === 204 ? null : await response.json();
        signal.throwIfAborted();
        if (!response.ok) {
            const parsed = v.safeParse(v.object({ error: v.object({ code: v.string(), message: v.string() }) }), value);
            throw new CloudApiError(
                parsed.success ? parsed.output.error.code : "MANAGEMENT_UNAVAILABLE",
                parsed.success ? parsed.output.error.message : "Chat management is unavailable.",
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
