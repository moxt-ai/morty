export interface BrowserNetworkOperations {
    readonly measureMortyLatency: (signal: AbortSignal) => Promise<number>;
}
export interface ServerNetworkOperations {
    readonly readNetwork: (signal: AbortSignal) => Promise<{
        readonly runtimeLatencyMs: number;
    }>;
}
export type NetworkMeasurement =
    | { readonly kind: "available"; readonly latencyMs: number }
    | { readonly kind: "unavailable"; readonly code: string };

export interface NetworkDiagnostics {
    readonly capturedAt: string;
    readonly online: boolean;
    readonly connection:
        | {
              readonly kind: "available";
              readonly effectiveType: string | null;
              readonly type: string | null;
              readonly downlinkMbps: number | null;
              readonly rttMs: number | null;
              readonly saveData: boolean | null;
          }
        | { readonly kind: "unavailable"; readonly code: string };
    readonly measurements: {
        readonly browserMorty: NetworkMeasurement;
        readonly mortyRuntime: NetworkMeasurement;
    };
}
