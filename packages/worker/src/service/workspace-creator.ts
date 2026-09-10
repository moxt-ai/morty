export interface WorkspaceCreator {
    readonly create: (
        input: {
            readonly userId: string;
            readonly name: string;
            readonly region: "apac" | "wnam";
        },
        signal: AbortSignal,
    ) => Promise<{ readonly canDelete: boolean; readonly id: string; readonly name: string }>;
}

export class WorkspaceCreationError extends Error {
    readonly code: "INVALID_INPUT" | "WORKSPACES_TIMEOUT" | "WORKSPACES_UNAVAILABLE";
    constructor(code: WorkspaceCreationError["code"], options?: ErrorOptions) {
        super(code, options);
        this.name = "WorkspaceCreationError";
        this.code = code;
    }
}
