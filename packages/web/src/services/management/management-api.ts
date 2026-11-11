import { decodeIdentifier, type Identifier, isIdentifier } from "@morty-build/client/protocol";
import * as v from "valibot";

const identifier = v.custom<Identifier>(isIdentifier);
const computerSchema = v.pipe(v.object({ computerId: identifier }), v.readonly());
export type ManagedComputer = v.InferOutput<typeof computerSchema>;
const machineSchema = v.object({ runtimePairing: v.picklist(["unpaired", "paired", "revoked"]) });

/**
 * Where the Machine's Runtime pairing stands: not yet paired (or its pairing request is pending or expired), paired,
 * or revoked until setup pairs it again. The Relay owns this fact; the Worker reads it for the Machine.
 */
export type RuntimePairing = v.InferOutput<typeof machineSchema>["runtimePairing"];

/** The Machine resource, read by setup and the page and polled by the browser for pairing changes. */
export function machineUrl(origin: string, computerId: string): URL {
    return managementUrl(origin, decodeIdentifier(computerId), "/machine");
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

    readonly readComputer = async (signal: AbortSignal): Promise<ManagedComputer | null> =>
        v.parse(
            v.object({ computer: v.nullable(computerSchema) }),
            await this.#request("/computer", "GET", undefined, signal),
        ).computer;

    readonly readRuntimePairing = async (signal: AbortSignal): Promise<RuntimePairing> =>
        v.parse(machineSchema, await this.#request("/machine", "GET", undefined, signal)).runtimePairing;

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

export function isComputerConnectionFailure(cause: unknown): boolean {
    return cause instanceof CloudApiError && runtimeConnectionCodes.has(cause.code.toLowerCase());
}
