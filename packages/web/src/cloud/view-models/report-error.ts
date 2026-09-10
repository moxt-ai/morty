import { captureException } from "@sentry/react";
import { WorkspaceError } from "./workspaces/contracts.ts";

export function reportApplicationError(error: unknown, operation: string): void {
    if (error instanceof DOMException && error.name === "AbortError") {
        return;
    }
    if (error instanceof WorkspaceError && error.code !== "UNAVAILABLE") {
        return;
    }
    captureException(error, { tags: { operation } });
}
