import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";

export function AttemptFailure({
    approval,
    code,
    message,
}: {
    readonly approval: { readonly kind: "bot-approval"; readonly botId: string } | { readonly kind: "unavailable" };
    readonly code: string;
    readonly message: string;
}) {
    const command =
        code === "binding_not_approved" && approval.kind === "bot-approval" && isIdentifier(approval.botId)
            ? `mobius bot approve --bot ${approval.botId}`
            : "";
    return (
        <div
            className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm [overflow-wrap:anywhere]"
            role="alert"
        >
            <p className="font-medium text-destructive">Response failed</p>
            <p className="mt-1 whitespace-pre-wrap">{message}</p>
            {code.length > 0 && <p className="mt-2 font-mono text-xs text-muted-foreground">{code}</p>}
            {command.length > 0 && (
                <div className="mt-4 border-t border-destructive/20 pt-4">
                    <p>Run this command in a terminal on your computer:</p>
                    <input
                        aria-label="Agent approval command"
                        className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring"
                        onFocus={(event) => event.currentTarget.select()}
                        readOnly
                        value={command}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                        After approval, resend your message here. Your agent and this session stay the same.
                    </p>
                </div>
            )}
        </div>
    );
}
