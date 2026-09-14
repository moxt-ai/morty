import { ValiError } from "valibot";
import { MobiusAppError } from "../components/chat/mobius-app-service.ts";
import { PlatformProjectError } from "../components/management/entity/platform-project.ts";
import { IdentityStorageError } from "../components/management/storage/identity-storage.ts";
import { ManagementStorageError } from "../components/management/storage/managed-bot-storage.ts";
import { json } from "./http.ts";

interface ErrorLogger {
    readonly error: (value: unknown, message: string) => void;
}

export function applicationErrorResponse(error: Error, logger: ErrorLogger): Response {
    if (error instanceof PlatformProjectError) {
        logger.error(
            {
                event: "platform-request-failed",
                code: error.code,
                status: error.status,
                causeName: error.cause instanceof Error ? error.cause.name : undefined,
                causeCode: error.cause instanceof PlatformProjectError ? error.cause.code : undefined,
                causeStatus: error.cause instanceof PlatformProjectError ? error.cause.status : undefined,
            },
            "Platform request failed",
        );
        return json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof ValiError) {
        return json({ error: { code: "INVALID_REQUEST", message: "The request is invalid." } }, 400);
    }
    if (error instanceof MobiusAppError) {
        return json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof ManagementStorageError) {
        const status = error.code === "BOT_ALREADY_CLAIMED" ? 409 : 503;
        return json({ error: { code: error.code, message: error.message } }, status);
    }
    if (error instanceof IdentityStorageError) {
        return json({ error: { code: error.code, message: error.message } }, 503);
    }
    logger.error({ error }, "Unhandled application error");
    return json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } }, 500);
}
