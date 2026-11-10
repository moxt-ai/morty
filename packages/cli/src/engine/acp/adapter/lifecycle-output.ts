import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";
import { AcpExecutionError } from "../acp-error.ts";
import type { AdapterSessionOpened, AdapterSessionScope } from "../native-history/preview-contract.ts";
import { sessionIdSchema } from "../protocol/native-session.ts";
import type { AcpExecutionConnection } from "./execution-connections.ts";

export function sessionWorkspace(scope: AdapterSessionScope) {
    return { cwd: scope.cwd, mcpServers: [] };
}

/** Only protocol-level rejection before admission permits repeating Session creation. */
export async function sessionCreationResponse(operation: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
    try {
        return await operation;
    } catch (cause) {
        signal.throwIfAborted();
        const rejection = cause instanceof AcpExecutionError ? cause.cause : cause;
        if (rejection instanceof RequestError && (rejection.code === -32601 || rejection.code === -32602)) {
            throw new AcpExecutionError(
                "The Agent refused the Session creation request before admission",
                { cause },
                "session_creation_refused",
            );
        }
        throw cause;
    }
}

export function createdSessionId(response: unknown): string {
    const decoded = z.object({ sessionId: sessionIdSchema }).safeParse(response);
    if (!decoded.success) {
        throw new AcpExecutionError(
            "The Agent returned an invalid native session",
            { cause: decoded.error },
            "invalid_native_session_response",
        );
    }
    return decoded.data.sessionId;
}

export async function normalizeOpenedSession(
    session: AcpExecutionConnection,
    sessionId: string,
    response: unknown,
    signal: AbortSignal,
): Promise<AdapterSessionOpened> {
    await session.connection.race(
        session.connection.events.drained(),
        "ACP agent exited while opening a session",
        signal,
    );
    signal.throwIfAborted();
    const initialized = await session.connection.initializeAgent(signal);
    return {
        sessionId,
        agentName: initialized.agentName,
        agentVersion: initialized.agentVersion,
        agentSettingsModelEffort: session.connection.agentSettingsModelEffort(),
        ...session.connection.commitLifecycle(response),
    };
}
