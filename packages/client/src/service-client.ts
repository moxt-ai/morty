import {
    type AgentSettingsDiscoveredEvent,
    CONTENT_WRITE_MAX_BYTES,
    decodeAgentSettingsDiscoveredEvent,
    decodeKnownNativeSessionEvents,
    decodeKnownSessionEventLogPage,
    decodeKnownSessionLiveEventBatch,
    decodeNativeSessionResult,
    decodePromptAttachment,
    decodeRuntimeDiagnosticsResult,
    decodeSessionArchivedEvent,
    decodeSessionClosedEvent,
    decodeSessionConfigReadResult,
    decodeSessionConfigUpdatedEvent,
    decodeSessionReadyEvent,
    decodeSessionRenamedEvent,
    decodeSessionRestoredEvent,
    decodeSessionsListedEvent,
    decodeSessionsQueriedEvent,
    decodeWorkspaceEntriesEvent,
    type ExternalAudioContentBlock,
    type ExternalImageContentBlock,
    type ExternalResourceContentBlock,
    isIdentifier,
    MORTY_API_PREFIX,
    type NativeEventPageRequest,
    type NativeSessionEvents,
    type NativeSessionRequest,
    type NativeSessionResult,
    type NativeSessionTarget,
    type PromptAttachment,
    type RuntimeDiagnosticsResult,
    type SessionConfigureCommand,
    type SessionEventLogPage,
    type SessionLiveEventBatch,
    SessionPromptDisposition,
    type WorkspaceEntriesEvent,
} from "@morty-build/client/protocol";
import {
    MortyApiError,
    MortyCancellationError,
    MortyConnectionError,
    MortyError,
    MortyProtocolError,
    MortyTimeoutError,
    MortyValidationError,
} from "./errors.ts";
import { sameNativeSession } from "./native-session.ts";
import { nativeSessionTargetSchema } from "./protocol/session/shared/native-session-target.ts";
import {
    type CreateMortySessionRequest,
    decodeMortyRuntimeList,
    decodeMortyRuntimePairing,
    decodeMortyRuntimePairingStatus,
    decodeMortyTurn,
    decodeRuntimeDescriptor,
    type MortyInteractionResponseRequest,
    type MortyPageRequest,
    MortyPairedRuntimePairingStatus,
    type MortyRuntimeDescriptor,
    type MortyRuntimePairing,
    MortyRuntimePairingLifecycle,
    type MortyRuntimePairingRequest,
    type MortyRuntimePairingStatus,
    type MortyRuntimePairingWaitOptions,
    MortySessionAccess,
    MortySessionAccessRevocation,
    type MortyTurn,
    type MortyTurnCancellation,
    type SubmitMortyTurnRequest,
} from "./resources.ts";

import {
    HttpTransport,
    isMortyLiveEventTransport,
    type MortyHttpTransport,
    type MortyTransportSessionEvent,
} from "./transport/http-transport.ts";

const DEFAULT_OPERATION_TIMEOUT_MILLISECONDS = 20_000;
const DEFAULT_STREAM_CONNECTION_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_STREAM_LIVENESS_TIMEOUT_MILLISECONDS = 45_000;
const DEFAULT_STREAM_RECONNECT_ATTEMPTS = 7;

function sanitizedConnectionCauseMessage(value: string): string {
    return Array.from(value, (character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
    })
        .join("")
        .trim()
        .slice(0, 1_024);
}

function connectionCauseMessages(cause: unknown): readonly string[] {
    const messages: string[] = [];
    const visited = new Set<unknown>();
    let current = cause;
    while (current instanceof Error && messages.length < 4 && !visited.has(current)) {
        visited.add(current);
        const message = sanitizedConnectionCauseMessage(current.message);
        if (message.length > 0) {
            messages.push(message);
        }
        current = current.cause;
    }
    return messages;
}

export interface MortyCredentialProvider {
    readonly credential: (signal: AbortSignal) => Promise<string>;
}

export interface DiscoverMortyAgentSettingsRequest {
    /**
     * The directory a new Session would start in; omitted, the Runtime's default directory. The result's `directory`
     * names the directory actually inspected.
     */
    readonly directory?: string;
    readonly model?: string;
}

/** A Session setting change. */
export type UpdateMortySessionConfigurationRequest = Pick<
    SessionConfigureCommand,
    "booleanValue" | "configId" | "expectedConfigurationRevision" | "value" | "valueType"
>;

export interface ForkMortyNativeSessionRequest {
    readonly harness: string;
    readonly sessionId: string;
    readonly directory: string;
}

export type MortyExternalContentBlock =
    | ExternalImageContentBlock
    | ExternalAudioContentBlock
    | ExternalResourceContentBlock;

export function externalContentPath(content: MortyExternalContentBlock): string {
    let kind: "audio" | "image" | "resource";
    let key: string;
    switch (content.type) {
        case "external_image":
            kind = "image";
            key = content.imageKey;
            break;
        case "external_audio":
            kind = "audio";
            key = content.audioKey;
            break;
        case "external_resource":
            kind = "resource";
            key = content.resourceKey;
            break;
        default:
            throw new MortyValidationError("The external content reference is invalid");
    }
    if (!/^[a-f0-9]{64}$/u.test(key)) {
        throw new MortyValidationError("The external content key is invalid");
    }
    return `morty-content:${kind}:${key}`;
}

export class StaticMortyCredentialProvider implements MortyCredentialProvider {
    readonly #token: string;

    constructor(token: string) {
        this.#token = validateCredential(token);
    }

    readonly credential = async (signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        return this.#token;
    };
}

function validateCredential(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length < 1 ||
        value.length > 4_096 ||
        value.includes("\r") ||
        value.includes("\n")
    ) {
        throw new MortyValidationError("The Morty credential is invalid");
    }
    return value;
}

export interface MortyResponseMetadata {
    readonly serverTiming: string | null;
    readonly status: number;
}

export interface MortyEndpointOptions {
    readonly authenticationProviderId?: string;
    readonly credentialProvider: MortyCredentialProvider;
    readonly endpoint: string;
    /** Set to zero when the caller owns live-stream recovery. */
    readonly maxStreamReconnectAttempts?: number;
    readonly observeResponse?: (metadata: MortyResponseMetadata) => void;
    readonly operationTimeoutMilliseconds?: number;
    readonly streamConnectionTimeoutMilliseconds?: number;
    readonly streamLivenessTimeoutMilliseconds?: number;
    readonly transport?: MortyHttpTransport;
}

export interface MortyClientOptions extends MortyEndpointOptions {
    readonly computerId: string;
}

function validatePositiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new MortyValidationError(`The ${name} is invalid`);
    }
    return value;
}

function normalizeEndpoint(value: string): URL {
    let endpoint: URL;
    try {
        endpoint = new URL(value);
    } catch (cause) {
        throw new MortyValidationError("The Morty endpoint is invalid", {
            cause,
        });
    }
    if (
        (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
        endpoint.username.length > 0 ||
        endpoint.password.length > 0 ||
        endpoint.search.length > 0 ||
        endpoint.hash.length > 0
    ) {
        throw new MortyValidationError("The Morty endpoint is invalid");
    }
    if (endpoint.pathname === "/") {
        endpoint.pathname = `${MORTY_API_PREFIX}/`;
    } else if (!endpoint.pathname.endsWith("/")) {
        endpoint.pathname = `${endpoint.pathname}/`;
    }
    return endpoint;
}

function decodeTurnCancellation(value: unknown, turnId: string): MortyTurnCancellation {
    if (
        typeof value !== "object" ||
        value === null ||
        Reflect.get(value, "turnId") !== turnId ||
        typeof Reflect.get(value, "stopReason") !== "string"
    ) {
        throw new MortyProtocolError("The service returned an invalid Turn cancellation");
    }
    return { turnId, stopReason: Reflect.get(value, "stopReason") };
}

function projectPath(computerId: string, resourcePath: string): string {
    if (!isIdentifier(computerId)) {
        throw new MortyValidationError("The Morty project identifier is invalid");
    }
    return `v1/computers/${encodeURIComponent(computerId)}/${resourcePath}`;
}

function nativeSessionRoute(target: NativeSessionTarget): string {
    const parsed = nativeSessionTargetSchema.safeParse(target);
    if (!parsed.success) {
        throw new MortyValidationError("The harness and native Session identity are invalid", { cause: parsed.error });
    }
    return `harnesses/${encodeURIComponent(parsed.data.harness)}/sessions/${encodeURIComponent(parsed.data.sessionId)}`;
}

function sessionPath(computerId: string, target: NativeSessionTarget, resourcePath: string): string {
    if (!nativeSessionTargetSchema.safeParse(target).success) {
        throw new MortyValidationError("The Morty Session identifier is invalid");
    }
    return projectPath(computerId, `${nativeSessionRoute(target)}/${resourcePath}`);
}

function requestUrl(endpoint: URL, path: string): URL {
    return new URL(path, endpoint);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
        throw new MortyProtocolError("The service returned an invalid error response");
    }
    return value;
}

async function responseValue(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch (cause) {
        throw new MortyProtocolError("The service returned invalid JSON", {
            cause,
        });
    }
}

async function throwApiError(response: Response): Promise<never> {
    const value = record(await responseValue(response));
    const error = record(value["error"]);
    const code = error["code"];
    const message = error["message"];
    if (typeof code !== "string" || typeof message !== "string") {
        throw new MortyProtocolError("The service returned an invalid error response");
    }
    throw new MortyApiError(code, message, response.status);
}

class RequestDeadline {
    readonly #controller = new AbortController();
    readonly #requestSignal: AbortSignal;
    readonly #timeoutId: ReturnType<typeof globalThis.setTimeout>;
    #timedOut = false;

    constructor(requestSignal: AbortSignal, timeoutMilliseconds: number) {
        this.#requestSignal = requestSignal;
        if (requestSignal.aborted) {
            this.#controller.abort(requestSignal.reason);
        } else {
            requestSignal.addEventListener("abort", this.abortFromRequest, {
                once: true,
            });
        }
        this.#timeoutId = globalThis.setTimeout(this.abortFromTimeout, timeoutMilliseconds);
    }

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    readonly finish = (): void => {
        globalThis.clearTimeout(this.#timeoutId);
        this.#requestSignal.removeEventListener("abort", this.abortFromRequest);
    };

    readonly translate = (cause: unknown): never => {
        if (this.#requestSignal.aborted) {
            throw new MortyCancellationError({ cause });
        }
        if (this.#timedOut) {
            throw new MortyTimeoutError({ cause });
        }
        if (cause instanceof MortyError) {
            throw cause;
        }
        throw new MortyConnectionError("The Morty service could not be reached", {
            cause,
        });
    };

    private readonly abortFromRequest = (): void => {
        this.#controller.abort(this.#requestSignal.reason);
    };

    private readonly abortFromTimeout = (): void => {
        this.#timedOut = true;
        this.#controller.abort(new Error("The Morty operation timed out"));
    };
}

class LiveEventConnection {
    readonly events: ReadableStream<MortyTransportSessionEvent>;
    readonly #controller: AbortController;
    readonly #release: () => void;
    #closed = false;

    constructor(events: ReadableStream<MortyTransportSessionEvent>, controller: AbortController, release: () => void) {
        this.events = events;
        this.#controller = controller;
        this.#release = release;
    }

    readonly close = (): void => {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#controller.abort(new Error("The live Session event connection closed"));
        this.#release();
    };
}

export class MortyRequestExecutor {
    readonly #authenticationProviderId: string;
    readonly #credentialProvider: MortyCredentialProvider;
    readonly #endpoint: URL;
    readonly #operationTimeoutMilliseconds: number;
    readonly #observeResponse: ((metadata: MortyResponseMetadata) => void) | undefined;
    readonly #streamConnectionTimeoutMilliseconds: number;
    readonly #streamLivenessTimeoutMilliseconds: number;
    readonly #transport: MortyHttpTransport;

    constructor(options: MortyEndpointOptions) {
        const authenticationProviderId = options.authenticationProviderId ?? "";
        if (
            authenticationProviderId.length > 128 ||
            authenticationProviderId.includes("\r") ||
            authenticationProviderId.includes("\n")
        ) {
            throw new MortyValidationError("The Morty authentication provider identifier is invalid");
        }
        this.#authenticationProviderId = authenticationProviderId;
        this.#credentialProvider = options.credentialProvider;
        this.#endpoint = normalizeEndpoint(options.endpoint);
        this.#operationTimeoutMilliseconds = validatePositiveInteger(
            options.operationTimeoutMilliseconds ?? DEFAULT_OPERATION_TIMEOUT_MILLISECONDS,
            "operation timeout",
        );
        this.#observeResponse = options.observeResponse;
        this.#streamConnectionTimeoutMilliseconds = validatePositiveInteger(
            options.streamConnectionTimeoutMilliseconds ?? DEFAULT_STREAM_CONNECTION_TIMEOUT_MILLISECONDS,
            "stream connection timeout",
        );
        this.#streamLivenessTimeoutMilliseconds = validatePositiveInteger(
            options.streamLivenessTimeoutMilliseconds ?? DEFAULT_STREAM_LIVENESS_TIMEOUT_MILLISECONDS,
            "stream liveness timeout",
        );
        this.#transport = options.transport ?? new HttpTransport();
    }

    readonly get = async (path: string, signal: AbortSignal): Promise<unknown> =>
        await this.request(path, "GET", "", false, signal);

    readonly getFile = async (
        path: string,
        maximumBytes: number,
        signal: AbortSignal,
    ): Promise<{
        readonly bytes: Uint8Array;
        readonly mediaType: string;
        readonly modifiedAt: string;
        readonly name: string;
    }> => {
        const deadline = new RequestDeadline(signal, this.#operationTimeoutMilliseconds);
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const response = await this.#transport.fetch(
                new Request(requestUrl(this.#endpoint, path), {
                    headers: this.authenticationHeaders(credential, "application/octet-stream"),
                    signal: deadline.signal,
                }),
            );
            this.#observeResponse?.({
                serverTiming: response.headers.get("server-timing"),
                status: response.status,
            });
            if (!response.ok) {
                await throwApiError(response);
            }
            const mediaType = response.headers.get("content-type") ?? "";
            const modifiedAt = response.headers.get("last-modified") ?? "";
            const encodedName = response.headers.get("x-morty-file-name") ?? "";
            const encodedLength = response.headers.get("x-morty-byte-length") ?? "";
            if (
                mediaType.length === 0 ||
                mediaType.length > 255 ||
                modifiedAt.length === 0 ||
                !/^\d+$/.test(encodedLength)
            ) {
                throw new MortyProtocolError("The service returned invalid file metadata");
            }
            const byteLength = Number(encodedLength);
            if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > maximumBytes) {
                throw new MortyProtocolError("The service returned an invalid file size");
            }
            let name: string;
            try {
                name = decodeURIComponent(encodedName);
            } catch (cause) {
                throw new MortyProtocolError("The service returned an invalid file name", { cause });
            }
            return {
                bytes: await readExactResponseBytes(response, byteLength, deadline.signal, false),
                mediaType,
                modifiedAt,
                name,
            };
        } catch (cause) {
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };

    readonly post = async (path: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
        const encoded = JSON.stringify(body);
        if (typeof encoded !== "string") {
            throw new MortyValidationError("The Morty request body is invalid");
        }
        return await this.request(path, "POST", encoded, true, signal);
    };

    readonly put = async (path: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
        const encoded = JSON.stringify(body);
        if (typeof encoded !== "string") {
            throw new MortyValidationError("The Morty request body is invalid");
        }
        return await this.request(path, "PUT", encoded, true, signal);
    };

    readonly putContent = async (
        path: string,
        bytes: Uint8Array,
        metadata: { readonly contentKind: "image" | "resource"; readonly mediaType: string; readonly name: string },
        signal: AbortSignal,
    ): Promise<unknown> => {
        const deadline = new RequestDeadline(signal, this.#operationTimeoutMilliseconds);
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const headers = this.authenticationHeaders(credential, "application/json");
            headers.set("content-type", metadata.mediaType);
            headers.set("x-morty-byte-length", bytes.byteLength.toString());
            headers.set("x-morty-content-kind", metadata.contentKind);
            headers.set("x-morty-file-name", encodeURIComponent(metadata.name));
            const body = bytes.slice().buffer;
            const response = await this.#transport.fetch(
                new Request(requestUrl(this.#endpoint, path), {
                    body,
                    headers,
                    method: "PUT",
                    signal: deadline.signal,
                }),
            );
            this.#observeResponse?.({
                serverTiming: response.headers.get("server-timing"),
                status: response.status,
            });
            if (!response.ok) {
                await throwApiError(response);
            }
            return await responseValue(response);
        } catch (cause) {
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };

    readonly delete = async (path: string, signal: AbortSignal): Promise<unknown> =>
        await this.request(path, "DELETE", "", false, signal);

    readonly deleteEmpty = async (path: string, signal: AbortSignal): Promise<void> => {
        await this.requestEmpty(path, "DELETE", signal);
    };

    readonly openLiveEventStream = async (path: string, signal: AbortSignal): Promise<LiveEventConnection> => {
        if (!isMortyLiveEventTransport(this.#transport)) {
            throw new MortyValidationError("The configured transport does not support live Session events");
        }
        const controller = new AbortController();
        const abort = (): void => controller.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        const timeoutId = globalThis.setTimeout(
            () => controller.abort(new Error("The live Session event connection timed out")),
            this.#streamConnectionTimeoutMilliseconds,
        );
        const release = (): void => {
            globalThis.clearTimeout(timeoutId);
            signal.removeEventListener("abort", abort);
        };
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(controller.signal));
            const events = await this.#transport.openSessionLiveEvents(
                new Request(requestUrl(this.#endpoint, path), {
                    headers: this.authenticationHeaders(credential, "application/json"),
                    signal: controller.signal,
                }),
            );
            globalThis.clearTimeout(timeoutId);
            return new LiveEventConnection(events, controller, release);
        } catch (cause) {
            release();
            if (signal.aborted) {
                throw new MortyCancellationError({ cause });
            }
            if (cause instanceof MortyError) {
                throw cause;
            }
            throw new MortyConnectionError("The live Session event stream could not connect", { cause });
        }
    };

    private readonly request = async (
        path: string,
        method: string,
        body: string,
        hasBody: boolean,
        signal: AbortSignal,
    ): Promise<unknown> => {
        const deadline = new RequestDeadline(signal, this.#operationTimeoutMilliseconds);
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const headers = this.authenticationHeaders(credential, "application/json");
            if (hasBody) {
                headers.set("content-type", "application/json");
            }
            const response = await this.#transport.fetch(
                new Request(requestUrl(this.#endpoint, path), {
                    body: hasBody ? body : null,
                    headers,
                    method,
                    signal: deadline.signal,
                }),
            );
            this.#observeResponse?.({
                serverTiming: response.headers.get("server-timing"),
                status: response.status,
            });
            if (!response.ok) {
                await throwApiError(response);
            }
            return await responseValue(response);
        } catch (cause) {
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };

    private readonly requestEmpty = async (path: string, method: string, signal: AbortSignal): Promise<void> => {
        const deadline = new RequestDeadline(signal, this.#operationTimeoutMilliseconds);
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const response = await this.#transport.fetch(
                new Request(requestUrl(this.#endpoint, path), {
                    headers: this.authenticationHeaders(credential, "application/json"),
                    method,
                    signal: deadline.signal,
                }),
            );
            this.#observeResponse?.({
                serverTiming: response.headers.get("server-timing"),
                status: response.status,
            });
            if (!response.ok) {
                await throwApiError(response);
            }
            if (response.status !== 204) {
                throw new MortyProtocolError("The service returned an invalid empty response");
            }
        } catch (cause) {
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };

    private readonly authenticationHeaders = (credential: string, accept: string): Headers => {
        const headers = new Headers({ accept, authorization: `Bearer ${credential}` });
        if (this.#authenticationProviderId.length > 0) {
            headers.set("x-morty-oidc-provider", this.#authenticationProviderId);
        }
        return headers;
    };
}

export async function readExactResponseBytes(
    response: Response,
    expectedByteLength: number,
    signal: AbortSignal,
    verifyDigest = true,
): Promise<Uint8Array> {
    const declaredLength = response.headers.get("content-length");
    if (
        declaredLength !== null &&
        (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) !== expectedByteLength)
    ) {
        throw new MortyProtocolError("The service returned an invalid artifact length");
    }
    const reader = response.body?.getReader();
    if (reader === undefined) {
        throw new MortyProtocolError("The service returned no artifact content");
    }
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) {
                break;
            }
            byteLength += chunk.value.byteLength;
            if (byteLength > expectedByteLength) {
                await reader.cancel("Artifact response exceeded its metadata");
                throw new MortyProtocolError("The service returned an oversized artifact");
            }
            chunks.push(chunk.value);
        }
    } finally {
        reader.releaseLock();
    }
    if (byteLength !== expectedByteLength) {
        throw new MortyProtocolError("The service returned an incomplete artifact");
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    if (verifyDigest) {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        signal.throwIfAborted();
        const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        if (sha256 !== response.headers.get("x-morty-sha256")) {
            throw new MortyProtocolError("The service returned artifact content with an invalid digest");
        }
    }
    return bytes;
}

export class MortyRuntimeResources {
    readonly #executor: MortyRequestExecutor;
    readonly #computerId: string;

    constructor(executor: MortyRequestExecutor, computerId: string) {
        this.#executor = executor;
        this.#computerId = computerId;
    }

    readonly list = async (signal: AbortSignal): Promise<readonly MortyRuntimeDescriptor[]> =>
        decodeMortyRuntimeList(await this.#executor.get(projectPath(this.#computerId, "runtimes"), signal));

    readonly getAgents = async (signal: AbortSignal) =>
        decodeRuntimeDescriptor(await this.#executor.get(projectPath(this.#computerId, `daemon/agents`), signal))
            .agents;

    /**
     * Read the Runtime's own bounded local diagnostic log through the Relay, for a
     * bug report filed without shell access to the machine. Entries carry
     * correlation identifiers and failure codes only; free text and local paths
     * stay on that machine. Requires the Runtime to be online: an offline Runtime
     * has no log reader to answer, so this reports `runtime_unavailable`.
     */
    readonly readDiagnostics = async (signal: AbortSignal): Promise<RuntimeDiagnosticsResult> => {
        return decodeRuntimeDiagnosticsResult(
            JSON.stringify(await this.#executor.get(projectPath(this.#computerId, `daemon/diagnostics`), signal)),
        );
    };

    readonly listWorkspace = async (directory: string, signal: AbortSignal): Promise<WorkspaceEntriesEvent> =>
        decodeWorkspaceEntriesEvent(
            JSON.stringify(
                await this.#executor.post(projectPath(this.#computerId, `daemon/workspace`), { directory }, signal),
            ),
        );

    readonly describeWorkspace = async (
        directory: string,
        signal: AbortSignal,
    ): Promise<Pick<WorkspaceEntriesEvent, "directory" | "directoryLabel">> => {
        const listing = decodeWorkspaceEntriesEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#computerId, `daemon/workspace`),
                    { directory, view: "metadata" },
                    signal,
                ),
            ),
        );
        return { directory: listing.directory, directoryLabel: listing.directoryLabel };
    };

    readonly discoverAgentSettings = async (
        harness: string,
        request: DiscoverMortyAgentSettingsRequest,
        signal: AbortSignal,
    ): Promise<AgentSettingsDiscoveredEvent> =>
        decodeAgentSettingsDiscoveredEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#computerId, `daemon/agents/${encodeURIComponent(harness)}/settings`),
                    request,
                    signal,
                ),
            ),
        );

    readonly nativeSessions = async (
        request:
            | (Omit<Extract<NativeSessionRequest, { readonly action: "list" }>, "kind" | "requestId"> & {})
            | (Omit<
                  Extract<NativeSessionRequest, { readonly action: "import" | "fork" }>,
                  "kind" | "requestId" | "action"
              > & { readonly action: "import" }),
        signal: AbortSignal,
    ) =>
        decodeNativeSessionResult(
            JSON.stringify(
                await this.#executor.post(projectPath(this.#computerId, `daemon/native-sessions`), request, signal),
            ),
        );

    /**
     * Forks the native session in the directory its entry names. The Runtime keeps the fork's receipt under
     * `operationId`: reuse the operationId and its inputs after an ambiguous failure, and the retry answers with the
     * original fork instead of creating another Session.
     */
    readonly forkNativeSession = async (
        operationId: string,
        request: ForkMortyNativeSessionRequest,
        signal: AbortSignal,
    ) => {
        const result = decodeNativeSessionResult(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#computerId, `daemon/native-session-forks/${encodeURIComponent(operationId)}`),
                    request,
                    signal,
                ),
            ),
        );
        if (
            result.action !== "fork" ||
            !sameNativeSession(result.ready.target, result.target) ||
            result.target.harness !== request.harness ||
            result.target.sessionId === request.sessionId
        ) {
            throw new MortyProtocolError("The service returned an invalid native Fork");
        }
        return result;
    };

    readonly querySessions = async (targets: readonly NativeSessionTarget[], signal: AbortSignal) =>
        decodeSessionsQueriedEvent(
            JSON.stringify(
                await this.#executor.post(projectPath(this.#computerId, `daemon/sessions/query`), { targets }, signal),
            ),
        ).entries;

    readonly listSessions = async (limit: number, signal: AbortSignal) => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
            throw new MortyValidationError("The Runtime Session list limit is invalid");
        }
        const path = requestUrl(new URL("https://morty.invalid/"), projectPath(this.#computerId, `daemon/sessions`));
        path.searchParams.set("limit", limit.toString());
        return decodeSessionsListedEvent(
            JSON.stringify(await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal)),
        ).entries;
    };

    readonly findNativeSessionBySessionId = async (
        request: Omit<Extract<NativeSessionRequest, { readonly action: "find" }>, "kind" | "requestId" | "action">,
        signal: AbortSignal,
    ) => {
        const result = decodeNativeSessionResult(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#computerId, `daemon/native-sessions`),
                    { ...request, action: "find" },
                    signal,
                ),
            ),
        );
        if (result.action !== "find") {
            throw new MortyProtocolError("The service returned an invalid native Session lookup");
        }
        return result;
    };

    readonly revoke = async (signal: AbortSignal): Promise<void> => {
        await this.#executor.deleteEmpty(projectPath(this.#computerId, "pairing"), signal);
    };
}

export class MortyRuntimePairingResources {
    readonly #executor: MortyRequestExecutor;
    readonly #computerId: string;

    constructor(executor: MortyRequestExecutor, computerId: string) {
        this.#executor = executor;
        this.#computerId = computerId;
    }

    readonly create = async (request: MortyRuntimePairingRequest, signal: AbortSignal): Promise<MortyRuntimePairing> =>
        decodeMortyRuntimePairing(await this.#executor.post(projectPath(this.#computerId, "pairing"), request, signal));

    readonly read = async (signal: AbortSignal): Promise<MortyRuntimePairingStatus> => {
        return decodeMortyRuntimePairingStatus(
            await this.#executor.get(projectPath(this.#computerId, "pairing"), signal),
        );
    };

    readonly waitUntilPaired = async (
        options: MortyRuntimePairingWaitOptions,
        signal: AbortSignal,
    ): Promise<MortyPairedRuntimePairingStatus> => {
        const deadline = Date.now() + options.timeoutMilliseconds;
        while (true) {
            if (signal.aborted) {
                throw new MortyCancellationError({ cause: signal.reason });
            }
            const status = await this.read(signal);
            if (status instanceof MortyPairedRuntimePairingStatus) {
                return status;
            }
            if (status.status === MortyRuntimePairingLifecycle.Expired) {
                throw new MortyApiError("runtime_pairing_expired", "The Runtime pairing expired", 410);
            }
            if (status.status === MortyRuntimePairingLifecycle.Revoked) {
                throw new MortyApiError("runtime_pairing_revoked", "The Runtime pairing was revoked", 410);
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new MortyTimeoutError();
            }
            await waitForPairingPoll(Math.min(options.pollIntervalMilliseconds, remaining), signal);
        }
    };
}

function waitForPairingPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.reject(new MortyCancellationError({ cause: signal.reason }));
    }
    return new Promise((resolve, reject) => {
        const timeout = globalThis.setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            resolve();
        }, milliseconds);
        const cancel = (): void => {
            globalThis.clearTimeout(timeout);
            reject(new MortyCancellationError({ cause: signal.reason }));
        };
        signal.addEventListener("abort", cancel, { once: true });
    });
}

export class MortySessionResources {
    readonly #executor: MortyRequestExecutor;
    readonly #computerId: string;

    constructor(executor: MortyRequestExecutor, computerId: string) {
        this.#executor = executor;
        this.#computerId = computerId;
    }

    readonly create = async (request: CreateMortySessionRequest, signal: AbortSignal) =>
        decodeSessionReadyEvent(
            JSON.stringify(
                await this.#executor.post(projectPath(this.#computerId, `daemon/sessions`), request, signal),
            ),
        );

    readonly readCreation = async (operationId: string, signal: AbortSignal) =>
        decodeSessionReadyEvent(
            JSON.stringify(
                await this.#executor.get(
                    projectPath(this.#computerId, `daemon/session-creations/${encodeURIComponent(operationId)}`),
                    signal,
                ),
            ),
        );

    /**
     * Has the Platform issue a Session credential, signed with a key only the Relay holds. Issued after a Session access
     * revocation, it is never covered by that revocation.
     */
    readonly createAccess = async (sessionTarget: NativeSessionTarget, expiresInSeconds: number, signal: AbortSignal) =>
        new MortySessionAccess(
            await this.#executor.post(
                sessionPath(this.#computerId, sessionTarget, "access-credentials"),
                { expiresInSeconds },
                signal,
            ),
        );

    /**
     * Revokes every Session credential issued for the Project until now and closes the live views opened with them.
     * Retrying is safe: a later revocation never undoes an earlier one.
     */
    readonly revokeAccess = async (signal: AbortSignal) =>
        new MortySessionAccessRevocation(
            await this.#executor.post(projectPath(this.#computerId, "session-access/revocations"), {}, signal),
        );

    /** Opens a Session the Runtime holds, with the Agent and directory it holds the Session with. */
    readonly load = async (sessionTarget: NativeSessionTarget, signal: AbortSignal) =>
        decodeSessionReadyEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#computerId, `daemon/${nativeSessionRoute(sessionTarget)}/load`),
                    {},
                    signal,
                ),
            ),
        );

    readonly restore = async (target: NativeSessionTarget, signal: AbortSignal) => {
        const parsed = nativeSessionTargetSchema.safeParse(target);
        if (!parsed.success) {
            throw new MortyValidationError("The harness and native Session identity are invalid", {
                cause: parsed.error,
            });
        }
        const restored = decodeSessionRestoredEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(
                        this.#computerId,
                        `daemon/harnesses/${encodeURIComponent(parsed.data.harness)}/sessions/${encodeURIComponent(parsed.data.sessionId)}/restore`,
                    ),
                    {},
                    signal,
                ),
            ),
        );
        if (
            restored.target.harness !== parsed.data.harness ||
            restored.target.sessionId !== parsed.data.sessionId ||
            restored.entry.harness !== parsed.data.harness ||
            restored.entry.sessionId !== parsed.data.sessionId ||
            restored.ready.harness !== parsed.data.harness ||
            !sameNativeSession(restored.entry.target, restored.ready.target)
        ) {
            throw new MortyProtocolError("The Runtime restored a different harness or native Session");
        }
        return restored;
    };

    readonly close = async (sessionTarget: NativeSessionTarget, signal: AbortSignal) =>
        decodeSessionClosedEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#computerId, `daemon/${nativeSessionRoute(sessionTarget)}/close`),
                    {},
                    signal,
                ),
            ),
        );

    /**
     * Removes the Session from the Sessions the Runtime holds, closing it first if it is open. The Agent's own history
     * stays. Archiving a Session the Runtime does not hold succeeds, so a retry after an ambiguous failure is safe.
     */
    readonly archive = async (sessionTarget: NativeSessionTarget, signal: AbortSignal) =>
        decodeSessionArchivedEvent(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#computerId, `daemon/${nativeSessionRoute(sessionTarget)}/archive`),
                    {},
                    signal,
                ),
            ),
        );

    readonly updateConfiguration = async (
        ...operation:
            | readonly [
                  computerId: string,
                  sessionTarget: NativeSessionTarget,
                  request: UpdateMortySessionConfigurationRequest,
                  signal: AbortSignal,
              ]
            | readonly [
                  sessionTarget: NativeSessionTarget,
                  request: UpdateMortySessionConfigurationRequest,
                  signal: AbortSignal,
              ]
    ) => {
        const result =
            operation.length === 3
                ? await this.#executor.post(
                      sessionPath(this.#computerId, operation[0], "configuration"),
                      operation[1],
                      operation[2],
                  )
                : await this.#executor.post(
                      projectPath(this.#computerId, `daemon/${nativeSessionRoute(operation[1])}/configuration`),
                      operation[2],
                      operation[3],
                  );
        return decodeSessionConfigUpdatedEvent(JSON.stringify(result));
    };

    readonly readConfiguration = async (
        ...operation:
            | readonly [sessionTarget: NativeSessionTarget, signal: AbortSignal]
            | readonly [computerId: string, sessionTarget: NativeSessionTarget, signal: AbortSignal]
    ) => {
        const result =
            operation.length === 2
                ? await this.#executor.get(sessionPath(this.#computerId, operation[0], "configuration"), operation[1])
                : await this.#executor.get(
                      projectPath(this.#computerId, `daemon/${nativeSessionRoute(operation[1])}/configuration`),
                      operation[2],
                  );
        return decodeSessionConfigReadResult(JSON.stringify(result));
    };

    readonly rename = async (
        ...operation:
            | readonly [computerId: string, sessionTarget: NativeSessionTarget, title: string, signal: AbortSignal]
            | readonly [sessionTarget: NativeSessionTarget, title: string, signal: AbortSignal]
    ) => {
        const result =
            operation.length === 3
                ? await this.#executor.post(
                      sessionPath(this.#computerId, operation[0], "rename"),
                      { title: operation[1] },
                      operation[2],
                  )
                : await this.#executor.post(
                      projectPath(this.#computerId, `daemon/${nativeSessionRoute(operation[1])}/rename`),
                      { title: operation[2] },
                      operation[3],
                  );
        return decodeSessionRenamedEvent(JSON.stringify(result));
    };

    readonly uploadContent = async (
        sessionTarget: NativeSessionTarget,
        input: {
            readonly bytes: Uint8Array;
            readonly contentKey: string;
            readonly kind: "image" | "resource";
            readonly mediaType: string;
            readonly name: string;
            readonly uri: string;
        },
        signal: AbortSignal,
    ): Promise<PromptAttachment> => {
        if (!/^[a-f0-9]{64}$/u.test(input.contentKey)) {
            throw new MortyValidationError("The content key is invalid");
        }
        if (input.bytes.byteLength < 1 || input.bytes.byteLength > CONTENT_WRITE_MAX_BYTES) {
            throw new MortyValidationError("The content size is invalid");
        }
        const query = new URLSearchParams({ uri: input.uri });
        return decodePromptAttachment(
            await this.#executor.putContent(
                `${sessionPath(this.#computerId, sessionTarget, `content/${input.contentKey}`)}?${query.toString()}`,
                input.bytes,
                { contentKind: input.kind, mediaType: input.mediaType, name: input.name },
                signal,
            ),
        );
    };

    readonly readFile = async (
        sessionTarget: NativeSessionTarget,
        path: string,
        signal: AbortSignal,
        maximumBytes = 32 * 1024 * 1024,
    ): Promise<{
        readonly bytes: Uint8Array;
        readonly mediaType: string;
        readonly modifiedAt: string;
        readonly name: string;
    }> => {
        if (path.length === 0 || path.length > 4_096) {
            throw new MortyValidationError("The file path is invalid");
        }
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 128 * 1024 * 1024) {
            throw new MortyValidationError("The file size limit is invalid");
        }
        const query = new URLSearchParams({ maxBytes: maximumBytes.toString(), path });
        return await this.#executor.getFile(
            `${sessionPath(this.#computerId, sessionTarget, "files/content")}?${query.toString()}`,
            maximumBytes,
            signal,
        );
    };

    readonly readExternalContent = async (
        sessionTarget: NativeSessionTarget,
        content: MortyExternalContentBlock,
        signal: AbortSignal,
        maximumBytes = content.byteLength,
    ): ReturnType<MortySessionResources["readFile"]> =>
        await this.readFile(sessionTarget, externalContentPath(content), signal, maximumBytes);

    /** Reads a page of the Agent's own history of a native session in `directory`, which the caller browses. */
    readonly previewRuntimeNativeEvents = async (
        sessionTarget: NativeSessionTarget,
        directory: string,
        page: NativeEventPageRequest,
        signal: AbortSignal,
    ): Promise<NativeSessionEvents> => {
        const result = await this.#executor.post(
            projectPath(this.#computerId, `daemon/${nativeSessionRoute(sessionTarget)}/native-events-preview`),
            {
                cursor: page.cursor,
                directory,
                eventLimit: page.eventLimit,
            },
            signal,
        );
        return decodeKnownNativeSessionEvents(result);
    };

    /** Reads a page of the Agent's own history of a native session in `directory`, which the caller browses. */
    readonly previewSessionNativeEvents = async (
        sessionTarget: NativeSessionTarget,
        directory: string,
        page: NativeEventPageRequest,
        signal: AbortSignal,
    ): Promise<NativeSessionEvents> => {
        const path = requestUrl(
            new URL("https://morty.invalid/"),
            sessionPath(this.#computerId, sessionTarget, "native-events-preview"),
        );
        path.searchParams.set("directory", directory);
        path.searchParams.set("eventLimit", page.eventLimit.toString());
        if (page.cursor !== null) {
            path.searchParams.set("cursor", page.cursor);
        }
        return decodeKnownNativeSessionEvents(
            await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal),
        );
    };

    /**
     * Reads the Session's execution. Naming a command also asks for that command's delivery;
     * `command` is present when the request names a command. `lastTurn` reports how the last
     * started command ended when none runs. A missing Session has no interaction snapshot.
     */
    readonly readSessionExecution = async (
        sessionTarget: NativeSessionTarget,
        signal: AbortSignal,
        commandId?: string,
    ): Promise<
        Pick<
            Extract<NativeSessionResult, { readonly action: "active-turn" }>,
            "turn" | "queued" | "command" | "lastTurn" | "queuedCancellation" | "interactionState" | "executionPosition"
        >
    > => {
        const path = requestUrl(
            new URL("https://morty.invalid/"),
            sessionPath(this.#computerId, sessionTarget, "active-turn"),
        );
        if (commandId !== undefined) {
            path.searchParams.set("commandId", commandId);
        }
        const result = decodeNativeSessionResult(
            JSON.stringify(await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal)),
        );
        if (result.action !== "active-turn" || !sameNativeSession(result.target, sessionTarget)) {
            throw new MortyProtocolError("The service returned an invalid active Turn");
        }
        return {
            turn: result.turn,
            queued: result.queued,
            ...(result.command === undefined ? {} : { command: result.command }),
            ...(result.lastTurn === undefined ? {} : { lastTurn: result.lastTurn }),
            queuedCancellation: result.queuedCancellation,
            interactionState: result.interactionState,
            executionPosition: result.executionPosition,
        };
    };

    readonly readRuntimeSessionExecution = async (
        sessionTarget: NativeSessionTarget,
        signal: AbortSignal,
    ): Promise<Pick<Extract<NativeSessionResult, { readonly action: "active-turn" }>, "turn" | "queued">> => {
        const result = decodeNativeSessionResult(
            JSON.stringify(
                await this.#executor.post(
                    projectPath(this.#computerId, `daemon/${nativeSessionRoute(sessionTarget)}/active-turn`),
                    {},
                    signal,
                ),
            ),
        );
        if (result.action !== "active-turn" || !sameNativeSession(result.target, sessionTarget)) {
            throw new MortyProtocolError("The service returned an invalid active Turn");
        }
        return { turn: result.turn, queued: result.queued };
    };
}

export class MortyTurnResources {
    readonly #executor: MortyRequestExecutor;
    readonly #computerId: string;

    constructor(executor: MortyRequestExecutor, computerId: string) {
        this.#executor = executor;
        this.#computerId = computerId;
    }

    readonly submit = async (
        sessionTarget: NativeSessionTarget,
        request: SubmitMortyTurnRequest,
        signal: AbortSignal,
    ): Promise<MortyTurn> => {
        const turn = decodeMortyTurn(
            await this.#executor.post(sessionPath(this.#computerId, sessionTarget, "turns"), request, signal),
        );
        if (turn === null) {
            throw new MortyProtocolError("The service returned an invalid Turn");
        }
        return turn;
    };

    readonly submitToRuntime = async (
        sessionTarget: NativeSessionTarget,
        request: SubmitMortyTurnRequest,
        signal: AbortSignal,
    ): Promise<{ readonly turnId: string }> => {
        const result = await this.#executor.post(
            projectPath(this.#computerId, `daemon/${nativeSessionRoute(sessionTarget)}/turns`),
            {
                ...request,
                disposition: request.disposition ?? SessionPromptDisposition.Append,
                sessionConfigurations: request.sessionConfigurations ?? [],
            },
            signal,
        );
        if (typeof result !== "object" || result === null || !("turnId" in result)) {
            throw new MortyProtocolError("The service returned an invalid Turn");
        }
        const turnId = Reflect.get(result, "turnId");
        if (typeof turnId !== "string") {
            throw new MortyProtocolError("The service returned an invalid Turn");
        }
        return { turnId };
    };

    readonly cancel = async (
        sessionTarget: NativeSessionTarget,
        turnId: string,
        signal: AbortSignal,
    ): Promise<MortyTurnCancellation> =>
        decodeTurnCancellation(
            await this.#executor.post(
                sessionPath(this.#computerId, sessionTarget, `turns/${encodeURIComponent(turnId)}/cancel`),
                {},
                signal,
            ),
            turnId,
        );

    /** Withdraws a queued prompt only when the Runtime confirms it did not execute. */
    readonly cancelQueued = async (
        sessionTarget: NativeSessionTarget,
        turnId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const result = await this.#executor.post(
            sessionPath(this.#computerId, sessionTarget, `turns/${encodeURIComponent(turnId)}/cancel-before-start`),
            {},
            signal,
        );
        if (typeof result !== "object" || result === null || Reflect.get(result, "turnId") !== turnId) {
            throw new MortyProtocolError("The service returned an invalid queued cancellation");
        }
    };

    readonly steer = async (
        sessionTarget: NativeSessionTarget,
        turnId: string,
        signal: AbortSignal,
    ): Promise<{ readonly turnId: string }> => {
        const result = await this.#executor.put(
            sessionPath(this.#computerId, sessionTarget, `turns/${encodeURIComponent(turnId)}/disposition`),
            { disposition: SessionPromptDisposition.Steer },
            signal,
        );
        if (typeof result !== "object" || result === null || Reflect.get(result, "turnId") !== turnId) {
            throw new MortyProtocolError("The service returned an invalid steered Turn");
        }
        return { turnId };
    };
}

export class MortyInteractionResources {
    readonly #executor: MortyRequestExecutor;
    readonly #computerId: string;

    constructor(executor: MortyRequestExecutor, computerId: string) {
        this.#executor = executor;
        this.#computerId = computerId;
    }

    // The Platform serves no interaction read routes: pending interactions come from the Session's lifecycle events and
    // its execution snapshot. Only the response submission crosses the Platform API.
    readonly respond = async (
        sessionTarget: NativeSessionTarget,
        interactionId: string,
        request: MortyInteractionResponseRequest,
        signal: AbortSignal,
    ): Promise<void> => {
        const result = await this.#executor.post(
            sessionPath(this.#computerId, sessionTarget, `interactions/${encodeURIComponent(interactionId)}/responses`),
            request,
            signal,
        );
        if (
            typeof result !== "object" ||
            result === null ||
            !("accepted" in result) ||
            Reflect.get(result, "accepted") !== true
        ) {
            throw new MortyProtocolError("The service returned an invalid Interaction response");
        }
    };
}

export type MortySessionLiveEventConnection = { readonly kind: "initial" } | { readonly kind: "reconnected" };

export interface MortySessionEventObserver {
    readonly receive: (events: SessionLiveEventBatch) => Promise<boolean>;
    readonly reconcile: (connection: MortySessionLiveEventConnection) => Promise<void>;
}

export class MortyLiveEventSubscription {
    readonly #controller = new AbortController();
    readonly #executor: MortyRequestExecutor;
    readonly #maximumReconnectAttempts: number;
    readonly #observer: MortySessionEventObserver;
    readonly #path: string;
    #closed = false;
    readonly connected: Promise<void>;
    readonly completed: Promise<void>;

    constructor(
        executor: MortyRequestExecutor,
        path: string,
        observer: MortySessionEventObserver,
        signal: AbortSignal,
        maximumReconnectAttempts: number,
    ) {
        this.#executor = executor;
        this.#maximumReconnectAttempts = maximumReconnectAttempts;
        this.#observer = observer;
        this.#path = path;
        const abort = (): void => this.#controller.abort(signal.reason);
        if (signal.aborted) {
            abort();
        } else {
            signal.addEventListener("abort", abort, { once: true });
        }
        let resolveConnected = (): void => undefined;
        let rejectConnected = (_cause: unknown): void => undefined;
        this.connected = new Promise<void>((resolve, reject) => {
            resolveConnected = resolve;
            rejectConnected = reject;
        });
        this.completed = this.run(resolveConnected, rejectConnected).finally(() =>
            signal.removeEventListener("abort", abort),
        );
    }

    readonly close = (): void => {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#controller.abort(new Error("The live session event subscription closed"));
    };

    private readonly run = async (
        resolveConnected: () => void,
        rejectConnected: (cause: unknown) => void,
    ): Promise<void> => {
        let attempts = 0;
        let connectionState: MortySessionLiveEventConnection = { kind: "initial" };
        while (!this.#closed) {
            let connection: LiveEventConnection | null = null;
            try {
                connection = await this.#executor.openLiveEventStream(this.#path, this.#controller.signal);
                await this.#observer.reconcile(connectionState);
                if (connectionState.kind === "initial") {
                    resolveConnected();
                    connectionState = { kind: "reconnected" };
                }
                attempts = 0;
                const reader = connection.events.getReader();
                try {
                    while (!this.#closed) {
                        const result = await reader.read();
                        if (result.done) {
                            throw new MortyConnectionError("The live session event stream disconnected");
                        }
                        let value: unknown;
                        try {
                            value = JSON.parse(result.value.data);
                        } catch (cause) {
                            throw new MortyProtocolError("The live session event stream contains invalid JSON", {
                                cause,
                            });
                        }
                        const events = decodeKnownSessionLiveEventBatch(value);
                        if (events.length === 0) {
                            continue;
                        }
                        if (!(await this.#observer.receive(events))) {
                            this.close();
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
            } catch (cause) {
                if (this.#closed || this.#controller.signal.aborted) {
                    if (connectionState.kind === "initial") {
                        rejectConnected(new MortyCancellationError({ cause }));
                    }
                    return;
                }
                if (
                    cause instanceof MortyProtocolError ||
                    (cause instanceof MortyApiError && cause.status < 500) ||
                    (cause instanceof MortyError &&
                        !(cause instanceof MortyConnectionError) &&
                        !(cause instanceof MortyTimeoutError) &&
                        !(cause instanceof MortyApiError))
                ) {
                    if (connectionState.kind === "initial") {
                        rejectConnected(cause);
                    }
                    throw cause;
                }
                attempts += 1;
                if (attempts > this.#maximumReconnectAttempts) {
                    const details = connectionCauseMessages(cause);
                    const message = `The live session event stream could not recover${
                        details.length > 0 ? `. Cause: ${details.join(". Caused by: ")}` : ""
                    }`;
                    const failure = new MortyConnectionError(message, { cause });
                    if (connectionState.kind === "initial") {
                        rejectConnected(failure);
                    }
                    throw failure;
                }
                await this.reconnectDelay(attempts);
            } finally {
                connection?.close();
            }
        }
    };

    private readonly reconnectDelay = async (attempt: number): Promise<void> => {
        const delayMilliseconds = Math.min(250 * 2 ** (attempt - 1), 2_000);
        await new Promise<void>((resolve, reject) => {
            const timeoutId = globalThis.setTimeout(() => {
                this.#controller.signal.removeEventListener("abort", abort);
                resolve();
            }, delayMilliseconds);
            const abort = (): void => {
                globalThis.clearTimeout(timeoutId);
                reject(new MortyCancellationError());
            };
            this.#controller.signal.addEventListener("abort", abort, { once: true });
        });
    };
}

export class MortyEventResources {
    readonly #executor: MortyRequestExecutor;
    readonly #maximumReconnectAttempts: number;
    readonly #computerId: string;
    readonly #liveSubscriptions = new Set<MortyLiveEventSubscription>();

    constructor(executor: MortyRequestExecutor, computerId: string, maximumReconnectAttempts: number) {
        this.#executor = executor;
        this.#maximumReconnectAttempts = maximumReconnectAttempts;
        this.#computerId = computerId;
    }

    readonly subscribeLive = async (
        sessionTarget: NativeSessionTarget,
        observer: MortySessionEventObserver,
        signal: AbortSignal,
    ): Promise<MortyLiveEventSubscription> => {
        const subscription = new MortyLiveEventSubscription(
            this.#executor,
            sessionPath(this.#computerId, sessionTarget, "events-v2"),
            observer,
            signal,
            this.#maximumReconnectAttempts,
        );
        this.#liveSubscriptions.add(subscription);
        void subscription.completed.finally(() => this.#liveSubscriptions.delete(subscription)).catch(() => undefined);
        await subscription.connected;
        return subscription;
    };

    readonly list = async (
        sessionTarget: NativeSessionTarget,
        page: MortyPageRequest,
        signal: AbortSignal,
    ): Promise<SessionEventLogPage> => {
        const path = requestUrl(
            new URL("https://morty.invalid/"),
            sessionPath(this.#computerId, sessionTarget, "events-v2"),
        );
        path.searchParams.set("limit", page.limit.toString());
        if (page.cursor.length > 0) {
            path.searchParams.set("cursor", page.cursor);
        }
        return decodeKnownSessionEventLogPage(
            await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal),
        );
    };

    readonly close = (): void => {
        for (const subscription of this.#liveSubscriptions) {
            subscription.close();
        }
        this.#liveSubscriptions.clear();
    };
}

export class MortyClient {
    readonly events: MortyEventResources;
    readonly interactions: MortyInteractionResources;
    readonly runtimePairings: MortyRuntimePairingResources;
    readonly runtimes: MortyRuntimeResources;
    readonly sessions: MortySessionResources;
    readonly turns: MortyTurnResources;

    constructor(options: MortyClientOptions) {
        const executor = new MortyRequestExecutor(options);
        const reconnectAttempts = options.maxStreamReconnectAttempts ?? DEFAULT_STREAM_RECONNECT_ATTEMPTS;
        if (!Number.isSafeInteger(reconnectAttempts) || reconnectAttempts < 0) {
            throw new MortyValidationError("The stream reconnect attempt limit is invalid");
        }
        this.events = new MortyEventResources(executor, options.computerId, reconnectAttempts);
        this.interactions = new MortyInteractionResources(executor, options.computerId);
        this.runtimePairings = new MortyRuntimePairingResources(executor, options.computerId);
        this.runtimes = new MortyRuntimeResources(executor, options.computerId);
        this.sessions = new MortySessionResources(executor, options.computerId);
        this.turns = new MortyTurnResources(executor, options.computerId);
    }

    readonly close = (): void => {
        this.events.close();
    };
}
