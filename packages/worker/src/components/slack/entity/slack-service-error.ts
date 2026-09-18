export class SlackServiceError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.code = code;
        this.name = "SlackServiceError";
    }

    readonly toResponse = (): Response =>
        Response.json(
            { error: { code: this.code, message: this.message } },
            { status: this.code === "CHAT_BOT_BINDING_NOT_CONFIGURED" ? 400 : 502 },
        );
}
