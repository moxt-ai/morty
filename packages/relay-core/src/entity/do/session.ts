import { SESSION_CLOSED_ERROR_CODE, type SessionOperationFailedEvent } from "@morty-build/client/protocol";
import type { HttpError } from "../http-error.ts";

export class ComputerScope {
    readonly computerId: string;

    constructor(computerId: string) {
        this.computerId = computerId;
    }
}

function sessionComputerErrorStatus(code: string): number {
    if (code === "session_not_found") {
        return 404;
    }
    if (
        code === "session_busy" ||
        code === SESSION_CLOSED_ERROR_CODE ||
        code === "session_conflict" ||
        code === "idempotency_conflict" ||
        // An operation the Computer started but cannot tell the end of: repeating it cannot answer differently.
        code === "session_creation_outcome_unknown" ||
        code === "command_result_expired" ||
        code === "turn_already_started" ||
        code === "permission_response_conflict" ||
        code === "session_configuration_conflict" ||
        code === "steering_target_unavailable" ||
        code === "steering_unsupported"
    ) {
        return 409;
    }
    if (code === "invalid_cursor" || code === "invalid_request") {
        return 400;
    }
    if (code === "unsupported_operation") {
        return 501;
    }
    return 503;
}

interface SessionComputerErrorOptions extends ErrorOptions {
    readonly computerTimings?: NonNullable<SessionOperationFailedEvent["computerTimings"]> | undefined;
}

export class SessionComputerError extends Error implements HttpError {
    readonly code: string;
    readonly httpStatus: number;
    readonly computerTimings: NonNullable<SessionOperationFailedEvent["computerTimings"]>;

    constructor(code: string, message: string, options: SessionComputerErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.httpStatus = sessionComputerErrorStatus(code);
        this.name = "SessionComputerError";
        this.computerTimings = options.computerTimings ?? [];
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.httpStatus,
    });
}

/**
 * The Computer answered a control command with its own `session.operation.failed`: it finished handling that command
 * without a result. Unlike a lost connection, timeout or invalid reply, nothing about the command is still in flight.
 */
export class ComputerOperationFailedError extends SessionComputerError {}
