import { captureException } from "@sentry/react";

export function reportApplicationError(error: unknown, operation: string): void {
    if (error instanceof DOMException && error.name === "AbortError") {
        return;
    }
    captureException(error, { tags: { operation } });
}
