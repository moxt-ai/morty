/**
 * Pure display summary of where a session runs. The view-model derives it;
 * the execution context bar renders it without knowing the workflow.
 */
export interface ExecutionContext {
    readonly machine: string;
    readonly agent: string;
    readonly directory: string | null;
    readonly directoryName: string;
    readonly directoryPlaceholder: string;
    readonly connection: "Connecting" | "Connected" | "Disconnected" | "Reconnecting" | "Unavailable" | "Closed";
}
