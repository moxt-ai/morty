import { decodeIdentifier, type Identifier, isIdentifier } from "@morty-build/client/protocol";
import * as v from "valibot";

const identifier = v.custom<Identifier>(isIdentifier);
const managedBotDetailSchema = v.pipe(
    v.object({
        displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
        configured: v.boolean(),
    }),
    v.readonly(),
);
export type ManagedBotDetail = v.InferOutput<typeof managedBotDetailSchema>;
const projectSchema = v.pipe(
    v.object({ computerId: identifier, displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(120)) }),
    v.readonly(),
);
export type ManagedProject = v.InferOutput<typeof projectSchema>;
const runtimeBindingSchema = v.object({ computerId: v.nullable(identifier) });

/** Whether the Worker binds the Machine to a Runtime. The Worker's record is the only source of this fact. */
export type RuntimeBinding = { readonly kind: "unbound" } | { readonly kind: "bound"; readonly computerId: Identifier };

/** The Machine's Runtime binding resource, read by setup and the page and polled by the browser. */
export function runtimeBindingUrl(origin: string, computerId: string): URL {
    return managementUrl(origin, decodeIdentifier(computerId), "/machine/runtime-binding");
}

function managementUrl(origin: string, computerId: Identifier, path: string): URL {
    return new URL(`/morty/api/computers/${encodeURIComponent(computerId)}/management${path}`, origin);
}

export interface ManagementApiOptions {
    readonly computerId: string;
    readonly fetchRequest: (request: Request) => Promise<Response>;
    readonly getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly origin: string;
    /** Told when the Worker refuses the access as unauthenticated; whoever owns that access decides what it means. */
    readonly credentialRejected?: () => void;
}

export class ManagementApi {
    readonly #fetchRequest: (request: Request) => Promise<Response>;
    readonly #getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly #origin: string;
    readonly #computerId: Identifier;
    readonly #credentialRejected: (() => void) | undefined;
    constructor(options: ManagementApiOptions) {
        this.#fetchRequest = options.fetchRequest;
        this.#getToken = options.getToken;
        this.#origin = options.origin;
        this.#computerId = decodeIdentifier(options.computerId);
        this.#credentialRejected = options.credentialRejected;
    }

    readonly readProject = async (signal: AbortSignal): Promise<ManagedProject | null> =>
        v.parse(
            v.object({ computer: v.nullable(projectSchema) }),
            await this.#request("/computer", "GET", undefined, signal),
        ).computer;

    readonly readBot = async (signal: AbortSignal): Promise<ManagedBotDetail> =>
        v.parse(managedBotDetailSchema, await this.#request("/machine", "GET", undefined, signal));

    readonly readRuntimeBinding = async (signal: AbortSignal): Promise<RuntimeBinding> => {
        const binding = v.parse(
            runtimeBindingSchema,
            await this.#request("/machine/runtime-binding", "GET", undefined, signal),
        );
        if (binding.computerId !== null && binding.computerId !== this.#computerId) {
            throw new CloudApiError("INVALID_RESPONSE", "Chat management returned another computer.");
        }
        return binding.computerId === null ? { kind: "unbound" } : { kind: "bound", computerId: binding.computerId };
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
            new Request(managementUrl(this.#origin, this.#computerId, path), {
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
        if (response.status === 401) {
            this.#credentialRejected?.();
        }
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
