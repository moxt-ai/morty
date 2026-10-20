import type { RuntimeDiagnosticsResult } from "@moxt-ai/mobius-sdk/protocol";
import type { ServerNetworkOperations } from "./network-diagnostics.ts";

export interface BrowserDiagnostic {
    readonly at: string;
    readonly component: "worker" | "relay" | "web";
    readonly operation: string;
    readonly outcome: string;
    readonly requestId: string;
    readonly elapsedMs: number;
    readonly closeCode?: number;
}
const entries: BrowserDiagnostic[] = [];
let discarded = 0;
export function recordBrowserDiagnostic(entry: BrowserDiagnostic): void {
    entries.push({
        ...entry,
        operation: entry.operation.slice(0, 80),
        outcome: entry.outcome.slice(0, 64),
        requestId: entry.requestId.slice(0, 64),
    });
    if (entries.length > 100) {
        entries.shift();
        discarded += 1;
    }
}
interface BrowserDiagnosticsSnapshot {
    readonly entries: readonly BrowserDiagnostic[];
    readonly discarded: number;
}
export const browserDiagnosticsSnapshot = (): BrowserDiagnosticsSnapshot => ({ entries: [...entries], discarded });

interface DaemonDiagnosticsSource extends ServerNetworkOperations {
    readonly botId: string;
    readonly sessionId: string | null;
    readonly nativeSessionId: string | null;
    readonly read: (signal: AbortSignal) => Promise<RuntimeDiagnosticsResult>;
}
let source: DaemonDiagnosticsSource | null = null;
export function registerDaemonDiagnostics(next: DaemonDiagnosticsSource): () => void {
    source = next;
    return () => {
        if (source === next) {
            source = null;
        }
    };
}
export const currentDaemonDiagnostics = (): DaemonDiagnosticsSource | null => source;

// Never store arbitrary error messages: they may contain prompts, paths or credentials.
export function recordBrowserError(operation: string, cause?: unknown): void {
    const code: unknown = cause instanceof Error ? Reflect.get(cause, "code") : undefined;
    const requestId: unknown = cause instanceof Error ? Reflect.get(cause, "requestId") : undefined;
    recordBrowserDiagnostic({
        at: new Date().toISOString(),
        component: "web",
        operation,
        outcome: typeof code === "string" && /^[A-Z][A-Z_]{1,63}$/u.test(code) ? code : "error",
        requestId: typeof requestId === "string" && /^[a-f0-9-]{36}$/u.test(requestId) ? requestId : "",
        elapsedMs: 0,
    });
}
