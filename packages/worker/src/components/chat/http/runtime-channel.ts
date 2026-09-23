import {
    decodeCommittedSessionEvent,
    decodeFileReadCommand,
    decodeMessageKind,
    decodeNativeSessionCancel,
    decodeNativeSessionRequest,
    decodeRecordedSessionEvent,
    decodeSessionCancelCommand,
    decodeSessionConfigureCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionPermissionRespondCommand,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    decodeWorkspaceListCommand,
    FILE_BEGIN_KIND,
    FILE_CHUNK_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    FILE_READ_KIND,
    NATIVE_SESSION_CANCEL_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    NATIVE_SESSION_RESULT_KIND,
    RUNTIME_STATUS_KIND,
    RUNTIME_WORKSPACE_BINDING_ID,
    SESSION_CANCEL_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_EVENT_COMMITTED_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";
import * as v from "valibot";
import type { ApplicationContext } from "../../../composition/application-context.ts";
import type { OperationTiming } from "../../../infra/operation-timing.ts";
import { PlatformProjectError, platformIdentifier } from "../../management/entity/platform-project.ts";
import type { ChatScope } from "../service/chat-service.ts";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_RUNTIME_BYTES = 32 * 1024 * 1024;
const IDLE_TIMEOUT_MILLISECONDS = 10 * 60 * 1000;
const envelopeSchema = v.object({
    kind: v.string(),
    requestId: v.optional(platformIdentifier),
    sessionId: v.optional(platformIdentifier),
});

function pairingToken(request: Request): string {
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((protocol) => protocol.trim());
    const credentials = protocols.filter((protocol) => protocol.startsWith("auth."));
    if (!protocols.includes("morty-runtime") || credentials.length !== 1 || protocols.length !== 2) {
        throw new PlatformProjectError("UNAUTHENTICATED", "Runtime access is unavailable.", 401);
    }
    const credential = credentials[0]?.slice("auth.".length) ?? "";
    if (credential.length === 0 || credential.length > 4096) {
        throw new PlatformProjectError("UNAUTHENTICATED", "Runtime access is unavailable.", 401);
    }
    return credential;
}

function messageEnvelope(data: unknown) {
    if (typeof data !== "string" || new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES) {
        throw new PlatformProjectError("INVALID_REQUEST", "The Runtime message is invalid.", 400);
    }
    const value: unknown = JSON.parse(data);
    return { encoded: data, envelope: v.parse(envelopeSchema, value) };
}

export async function openBotRuntimeChannel(input: {
    readonly request: Request;
    readonly projectId: string;
    readonly botId: string;
    readonly dependencies: ApplicationContext;
    readonly timing: OperationTiming;
}): Promise<Response> {
    const { request, dependencies } = input;
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        throw new PlatformProjectError("INVALID_REQUEST", "A WebSocket connection is required.", 400);
    }
    if (request.headers.get("origin") !== dependencies.config.bindings.APP_ORIGIN) {
        throw new PlatformProjectError("ACCESS_DENIED", "The browser origin is not allowed.", 403);
    }
    const token = pairingToken(request);
    const authentication = await dependencies.services.authentication.session(token, request.signal);
    if (authentication.kind !== "authenticated") {
        throw new PlatformProjectError("UNAUTHENTICATED", "Sign in to continue.", 401);
    }
    const projectId = v.parse(platformIdentifier, input.projectId);
    const botId = v.parse(platformIdentifier, input.botId);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
    const scope = await dependencies.services.chat.authorize(
        authentication.session.userId,
        projectId,
        botId,
        signal,
        input.timing,
    );
    const configuration = await dependencies.services.chat.localRuntime(scope);
    const upstream = await dependencies.gateways.platformProjects.openChatRuntimeHost(
        projectId,
        configuration.runtimeId,
        request.signal,
    );
    upstream.accept();
    const sockets = new WebSocketPair();
    const browser = sockets[0];
    const server = sockets[1];
    server.accept();
    const allowedRequests = new Set<string>();
    const allowedSessions = new Set<string>();
    let closed = false;
    let timeout: ReturnType<typeof setTimeout>;
    const close = (code: number, reason: string) => {
        if (closed) {
            return;
        }
        closed = true;
        dependencies.logger.warn(
            { event: "bot-runtime-channel-closed", botId, code, reason },
            "Runtime channel closed",
        );
        clearTimeout(timeout);
        server.close(code, reason);
        upstream.close(code, reason);
    };
    const liveness = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => close(1001, "Runtime connection idle"), IDLE_TIMEOUT_MILLISECONDS);
    };
    const ownsSession = async (sessionId: string): Promise<boolean> => {
        if (allowedSessions.has(sessionId)) {
            return true;
        }
        const checkScope: ChatScope = { ...scope, signal: AbortSignal.timeout(15_000) };
        try {
            await dependencies.services.chat.requireLocalSession(checkScope, sessionId);
            allowedSessions.add(sessionId);
            return true;
        } catch {
            return false;
        }
    };
    const rememberRequest = (requestId: string) => {
        if (allowedRequests.size >= 128) {
            throw new PlatformProjectError("TOO_MANY_REQUESTS", "Too many Runtime operations are in progress.", 429);
        }
        allowedRequests.add(requestId);
    };
    const authorizeInbound = async (data: unknown): Promise<string> => {
        const { encoded } = messageEnvelope(data);
        const kind = decodeMessageKind(encoded);
        if (kind === NATIVE_SESSION_REQUEST_KIND) {
            const command = decodeNativeSessionRequest(encoded);
            if (command.agentId !== configuration.agentRef || command.bindingId !== botId) {
                throw new PlatformProjectError("ACCESS_DENIED", "The Agent does not belong to this Bot.", 403);
            }
            if (
                (command.action === "import" || command.action === "fork" || command.action === "linked-history") &&
                !(await ownsSession(command.targetSessionId))
            ) {
                throw new PlatformProjectError("ACCESS_DENIED", "The Session does not belong to this Bot.", 403);
            }
            if (command.action === "delete") {
                throw new PlatformProjectError("ACCESS_DENIED", "Delete this Session through Chat.", 403);
            }
            rememberRequest(command.requestId);
            return JSON.stringify({ ...command, bindingId: RUNTIME_WORKSPACE_BINDING_ID });
        }
        if (kind === NATIVE_SESSION_CANCEL_KIND) {
            const command = decodeNativeSessionCancel(encoded);
            if (!allowedRequests.has(command.requestId)) {
                throw new PlatformProjectError("ACCESS_DENIED", "The request does not belong to this Bot.", 403);
            }
            return encoded;
        }
        if (kind === WORKSPACE_LIST_KIND) {
            const command = decodeWorkspaceListCommand(encoded);
            if (command.bindingId !== botId) {
                throw new PlatformProjectError("ACCESS_DENIED", "The workspace does not belong to this Bot.", 403);
            }
            rememberRequest(command.requestId);
            return JSON.stringify({ ...command, bindingId: RUNTIME_WORKSPACE_BINDING_ID });
        }
        let sessionId: string;
        let forwarded = encoded;
        if (kind === SESSION_PROMPT_KIND) {
            const command = decodeSessionPromptCommand(encoded);
            if (command.agentId !== configuration.agentRef || command.bindingId !== botId) {
                throw new PlatformProjectError("ACCESS_DENIED", "The Agent does not belong to this Bot.", 403);
            }
            sessionId = command.sessionId;
            forwarded = JSON.stringify({ ...command, bindingId: RUNTIME_WORKSPACE_BINDING_ID });
        } else if (kind === SESSION_PREPARE_KIND) {
            const command = decodeSessionPrepareCommand(encoded);
            if (command.agentId !== configuration.agentRef || command.bindingId !== botId) {
                throw new PlatformProjectError("ACCESS_DENIED", "The Agent does not belong to this Bot.", 403);
            }
            rememberRequest(command.requestId);
            sessionId = command.sessionId;
            forwarded = JSON.stringify({ ...command, bindingId: RUNTIME_WORKSPACE_BINDING_ID });
        } else if (kind === SESSION_CONFIGURE_KIND) {
            const command = decodeSessionConfigureCommand(encoded);
            if (command.agentId !== configuration.agentRef || command.bindingId !== botId) {
                throw new PlatformProjectError("ACCESS_DENIED", "The Agent does not belong to this Bot.", 403);
            }
            rememberRequest(command.requestId);
            sessionId = command.sessionId;
            forwarded = JSON.stringify({ ...command, bindingId: RUNTIME_WORKSPACE_BINDING_ID });
        } else if (kind === SESSION_CANCEL_KIND) {
            sessionId = decodeSessionCancelCommand(encoded).sessionId;
        } else if (kind === SESSION_PERMISSION_RESPOND_KIND) {
            sessionId = decodeSessionPermissionRespondCommand(encoded).sessionId;
        } else if (kind === SESSION_ELICITATION_RESPOND_KIND) {
            sessionId = decodeSessionElicitationRespondCommand(encoded).sessionId;
        } else if (kind === FILE_READ_KIND) {
            const command = decodeFileReadCommand(encoded);
            rememberRequest(command.requestId);
            sessionId = command.sessionId;
        } else {
            throw new PlatformProjectError("ACCESS_DENIED", "This Runtime operation is unavailable.", 403);
        }
        if (!(await ownsSession(sessionId))) {
            throw new PlatformProjectError("ACCESS_DENIED", "The Session does not belong to this Bot.", 403);
        }
        return forwarded;
    };
    let inbound = Promise.resolve();
    server.addEventListener("message", (event) => {
        inbound = inbound.then(async () => {
            if (closed) {
                return;
            }
            liveness();
            try {
                const encoded = await authorizeInbound(event.data);
                upstream.send(encoded);
            } catch (error) {
                dependencies.logger.warn(
                    {
                        event: "bot-runtime-operation-rejected",
                        botId,
                        code: error instanceof PlatformProjectError ? error.code : "INVALID_MESSAGE",
                    },
                    "Runtime operation rejected",
                );
                close(1008, "Runtime operation denied");
            }
        });
    });
    let outbound = Promise.resolve();
    let pendingRuntimeBytes = 0;
    upstream.addEventListener("message", (event) => {
        if (closed) {
            return;
        }
        if (typeof event.data !== "string") {
            close(1002, "Invalid Runtime message");
            return;
        }
        const messageBytes = new TextEncoder().encode(event.data).byteLength;
        if (messageBytes > MAX_MESSAGE_BYTES || pendingRuntimeBytes + messageBytes > MAX_PENDING_RUNTIME_BYTES) {
            close(1009, "Runtime channel capacity exceeded");
            return;
        }
        pendingRuntimeBytes += messageBytes;
        outbound = outbound.then(async () => {
            if (closed) {
                pendingRuntimeBytes -= messageBytes;
                return;
            }
            liveness();
            try {
                const { encoded, envelope } = messageEnvelope(event.data);
                const requestResult =
                    (envelope.kind === NATIVE_SESSION_RESULT_KIND ||
                        envelope.kind === WORKSPACE_ENTRIES_KIND ||
                        envelope.kind === SESSION_OPERATION_FAILED_KIND ||
                        envelope.kind === FILE_BEGIN_KIND ||
                        envelope.kind === FILE_CHUNK_KIND ||
                        envelope.kind === FILE_END_KIND ||
                        envelope.kind === FILE_FAILED_KIND) &&
                    envelope.requestId !== undefined &&
                    allowedRequests.has(envelope.requestId);
                const committed =
                    envelope.kind === SESSION_EVENT_COMMITTED_KIND &&
                    envelope.sessionId !== undefined &&
                    (await ownsSession(envelope.sessionId));
                const promptEcho =
                    envelope.kind === SESSION_PROMPT_KIND &&
                    envelope.sessionId !== undefined &&
                    (await ownsSession(envelope.sessionId));
                if (promptEcho) {
                    decodeSessionPromptCommand(encoded);
                }
                if (committed) {
                    const event = decodeCommittedSessionEvent(encoded);
                    const payload = decodeRecordedSessionEvent(event.payload);
                    if (payload.sessionId !== event.sessionId) {
                        throw new PlatformProjectError("INVALID_MESSAGE", "The Runtime event is invalid.", 400);
                    }
                }
                const forward = envelope.kind === RUNTIME_STATUS_KIND || requestResult || committed || promptEcho;
                if (forward) {
                    server.send(encoded);
                    if (
                        envelope.requestId !== undefined &&
                        (envelope.kind === NATIVE_SESSION_RESULT_KIND ||
                            envelope.kind === WORKSPACE_ENTRIES_KIND ||
                            envelope.kind === SESSION_OPERATION_FAILED_KIND ||
                            envelope.kind === FILE_END_KIND ||
                            envelope.kind === FILE_FAILED_KIND)
                    ) {
                        allowedRequests.delete(envelope.requestId);
                    }
                }
            } catch {
                close(1002, "Invalid Runtime message");
            } finally {
                pendingRuntimeBytes -= messageBytes;
            }
        });
    });
    server.addEventListener("close", () => close(1000, "Browser disconnected"));
    upstream.addEventListener("close", () => close(1001, "Runtime disconnected"));
    liveness();
    dependencies.logger.info(
        { event: "bot-runtime-connected", projectId, userId: scope.userId, botId, runtimeId: configuration.runtimeId },
        "Chat audit event",
    );
    return new Response(null, {
        status: 101,
        webSocket: browser,
        headers: { "Sec-WebSocket-Protocol": "morty-runtime" },
    });
}
