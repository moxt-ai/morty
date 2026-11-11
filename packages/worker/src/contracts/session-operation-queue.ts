export interface SessionOperationQueue {
    readonly run: <Result>(
        sessionKey: string,
        signal: AbortSignal,
        operation: () => Promise<Result>,
    ) => Promise<Result>;
}
