import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { AcpExecutionError } from "../acp-error.ts";

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
