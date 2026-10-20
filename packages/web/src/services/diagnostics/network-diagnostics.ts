import * as v from "valibot";

const connectionSchema = v.object({
    effectiveType: v.optional(v.picklist(["slow-2g", "2g", "3g", "4g"])),
    type: v.optional(v.picklist(["bluetooth", "cellular", "ethernet", "none", "wifi", "wimax", "other", "unknown"])),
    downlink: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
    rtt: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
    saveData: v.optional(v.boolean()),
});

export interface BrowserNetworkOperations {
    readonly measureMortyLatency: (signal: AbortSignal) => Promise<number>;
    readonly measureMobiusLatency: (origin: string, signal: AbortSignal) => Promise<number>;
}
export interface ServerNetworkOperations {
    readonly readNetwork: (signal: AbortSignal) => Promise<{
        readonly mobiusDaemonLatencyMs: number;
        readonly mobiusOrigin: string;
        readonly mortyMobiusLatencyMs: number;
    }>;
}
let current: BrowserNetworkOperations | null = null;
export function registerBrowserNetworkDiagnostics(operations: BrowserNetworkOperations): () => void {
    current = operations;
    return () => {
        if (current === operations) {
            current = null;
        }
    };
}

type Probe<T> =
    | { readonly kind: "available"; readonly value: T }
    | { readonly kind: "unavailable"; readonly code: string };
const unavailable = (code: string): Extract<Probe<never>, { readonly kind: "unavailable" }> => ({
    kind: "unavailable",
    code,
});
async function probe<T>(read: () => Promise<T>, signal: AbortSignal, parent: AbortSignal): Promise<Probe<T>> {
    try {
        signal.throwIfAborted();
        const value = await read();
        signal.throwIfAborted();
        return { kind: "available", value };
    } catch (cause) {
        parent.throwIfAborted();
        const code: unknown = cause instanceof Error ? Reflect.get(cause, "code") : undefined;
        if (signal.aborted) {
            return unavailable("NETWORK_DIAGNOSTIC_TIMEOUT");
        }
        if (typeof code === "string" && /^[A-Z_a-z0-9]{1,64}$/u.test(code)) {
            return unavailable(code);
        }
        return unavailable("NETWORK_DIAGNOSTIC_FAILED");
    }
}
type Latency =
    | { readonly kind: "available"; readonly latencyMs: number }
    | Extract<Probe<never>, { readonly kind: "unavailable" }>;
const latency = (result: Probe<number>): Latency =>
    result.kind === "available" ? { kind: "available", latencyMs: result.value } : result;

function browserConnection() {
    try {
        const connection = v.safeParse(connectionSchema, Reflect.get(navigator, "connection"));
        if (connection.success) {
            return {
                kind: "available",
                effectiveType: connection.output.effectiveType ?? null,
                type: connection.output.type ?? null,
                downlinkMbps: connection.output.downlink ?? null,
                rttMs: connection.output.rtt ?? null,
                saveData: connection.output.saveData ?? null,
            };
        }
    } catch {
        return unavailable("NETWORK_INFORMATION_READ_FAILED");
    }
    return unavailable("NETWORK_INFORMATION_UNAVAILABLE");
}

export async function collectNetworkDiagnostics(server: ServerNetworkOperations | null, parent: AbortSignal) {
    parent.throwIfAborted();
    const capturedAt = new Date().toISOString();
    const online = navigator.onLine;
    const connection = browserConnection();
    const browser = current;
    const signal = AbortSignal.any([parent, AbortSignal.timeout(5_000)]);
    const [browserMorty, hops] = await Promise.all([
        browser === null
            ? unavailable("NO_ACTIVE_TRANSPORT")
            : probe(() => browser.measureMortyLatency(signal), signal, parent),
        server === null ? unavailable("NO_ACTIVE_RUNTIME") : probe(() => server.readNetwork(signal), signal, parent),
    ]);
    async function measureBrowserMobius(): Promise<Probe<number>> {
        if (hops.kind !== "available") {
            return unavailable(hops.code);
        }
        if (browser === null) {
            return unavailable("NO_ACTIVE_TRANSPORT");
        }
        return await probe(() => browser.measureMobiusLatency(hops.value.mobiusOrigin, signal), signal, parent);
    }
    const browserMobius = await measureBrowserMobius();
    parent.throwIfAborted();
    return {
        capturedAt,
        online,
        connection,
        measurements: {
            browserMorty: latency(browserMorty),
            browserMobius: latency(browserMobius),
            mortyMobius:
                hops.kind === "available"
                    ? latency({ kind: "available", value: hops.value.mortyMobiusLatencyMs })
                    : hops,
            mobiusDaemon:
                hops.kind === "available"
                    ? latency({ kind: "available", value: hops.value.mobiusDaemonLatencyMs })
                    : hops,
        },
    };
}
