export interface ErrorToResponse {
    readonly toResponse: () => Response;
}

export function hasErrorResponse(error: object): error is ErrorToResponse {
    return "toResponse" in error && typeof error.toResponse === "function";
}
