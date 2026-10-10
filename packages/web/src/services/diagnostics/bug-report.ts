import type { RuntimeDiagnosticsResult } from "@moxt-ai/mobius-protocol";
import { captureFeedback, getClient, lastEventId } from "@sentry/react";
import { browserDiagnosticsSnapshot, currentDaemonDiagnostics } from "./browser-diagnostics.ts";

export interface BugReport {
    readonly id: string;
    readonly createdAt: string;
    readonly description: string;
    readonly page: string;
    readonly release: string;
    readonly browser: string;
    readonly relatedEventId: string | null;
    readonly botId: string | null;
    readonly sessionId: string | null;
    readonly web: ReturnType<typeof browserDiagnosticsSnapshot>;
    readonly daemon:
        | { readonly kind: "available"; readonly diagnostics: RuntimeDiagnosticsResult }
        | { readonly kind: "unavailable"; readonly code: string };
}
export interface BugReportSink {
    readonly submit: (report: BugReport, signal: AbortSignal) => Promise<string>;
}
export class BugReportError extends Error {
    readonly code: "REPORTING_UNAVAILABLE" | "REPORT_REJECTED" | "REPORT_TOO_LARGE";
    constructor(code: BugReportError["code"], message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
    }
}

export async function collectBugReport(description: string, signal: AbortSignal): Promise<BugReport> {
    signal.throwIfAborted();
    const source = currentDaemonDiagnostics();
    const web = browserDiagnosticsSnapshot();
    let daemon: BugReport["daemon"] = { kind: "unavailable", code: "NO_ACTIVE_RUNTIME" };
    if (source !== null) {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
        try {
            daemon = { kind: "available", diagnostics: await source.read(deadline) };
        } catch (cause) {
            signal.throwIfAborted();
            const code: unknown = cause instanceof Error ? Reflect.get(cause, "code") : undefined;
            daemon = {
                kind: "unavailable",
                code: deadline.aborted
                    ? "DIAGNOSTIC_TIMEOUT"
                    : typeof code === "string" && /^[A-Z_a-z0-9]{1,64}$/u.test(code)
                      ? code
                      : "DIAGNOSTIC_UNAVAILABLE",
            };
        }
    }
    signal.throwIfAborted();
    return {
        id: crypto.randomUUID().replaceAll("-", ""),
        createdAt: new Date().toISOString(),
        description: description.trim().slice(0, 2000),
        page: window.location.pathname.slice(0, 512),
        relatedEventId: lastEventId() ?? null,
        browser: navigator.userAgent.slice(0, 512),
        release: (getClient()?.getOptions().release ?? "development").slice(0, 128),
        botId: source?.botId ?? null,
        sessionId: source?.sessionId ?? null,
        web,
        daemon,
    };
}

export const sentryBugReportSink: BugReportSink = {
    submit: async (report, parent) => {
        const client = getClient();
        if (client === undefined || client.getDsn() === undefined) {
            throw new BugReportError(
                "REPORTING_UNAVAILABLE",
                "Bug reporting is not configured. Please try again later.",
            );
        }
        const data = JSON.stringify(report);
        if (new TextEncoder().encode(data).byteLength > 350_000) {
            throw new BugReportError("REPORT_TOO_LARGE", "Diagnostics exceeded the report limit.");
        }
        const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
        signal.throwIfAborted();
        return await new Promise<string>((resolve, reject) => {
            const release = client.on("afterSendEvent", (event, response) => {
                if (event.event_id !== report.id) {
                    return;
                }
                cleanup();
                if (response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300) {
                    resolve(report.id);
                } else {
                    reject(new BugReportError("REPORT_REJECTED", "The report was not accepted. Please try again."));
                }
            });
            const abort = () => {
                cleanup();
                reject(signal.reason);
            };
            const cleanup = () => {
                release();
                signal.removeEventListener("abort", abort);
            };
            signal.addEventListener("abort", abort, { once: true });
            try {
                captureFeedback(
                    {
                        message: report.description,
                        source: "morty",
                        tags: { reportId: report.id },
                        ...(report.relatedEventId === null ? {} : { associatedEventId: report.relatedEventId }),
                    },
                    {
                        event_id: report.id,
                        includeReplay: false,
                        attachments: [{ filename: "diagnostics.json", contentType: "application/json", data }],
                    },
                );
            } catch (cause) {
                cleanup();
                reject(
                    new BugReportError("REPORT_REJECTED", "The report could not be sent. Please try again.", { cause }),
                );
            }
        });
    },
};
