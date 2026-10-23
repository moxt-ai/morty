export class ChatConnectionError extends Error {
    readonly code: "CHAT_CONNECTION_LOST" | "CHAT_CONNECTION_TIMEOUT";

    constructor(
        code: "CHAT_CONNECTION_LOST" | "CHAT_CONNECTION_TIMEOUT" = "CHAT_CONNECTION_LOST",
        options?: ErrorOptions,
    ) {
        super(
            code === "CHAT_CONNECTION_TIMEOUT"
                ? "Chat did not finish reconnecting."
                : "The connection to Chat was interrupted.",
            options,
        );
        this.name = "ChatConnectionError";
        this.code = code;
    }
}
