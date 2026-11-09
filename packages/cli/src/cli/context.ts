export interface CliContext {
    readonly shutdownSignal: AbortSignal;
    readonly entry: string;
    readonly version: string;
}
