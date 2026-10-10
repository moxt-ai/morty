import { captureException } from "@sentry/react";
import { recordBrowserError } from "../services/diagnostics/browser-diagnostics.ts";

export function reportApplicationError(error: unknown, operation: string): void {
    if (error instanceof DOMException && error.name === "AbortError") {
        return;
    }
    recordBrowserError(operation);
    captureException(error, { tags: { operation } });
}
