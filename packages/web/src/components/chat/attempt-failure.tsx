import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/cloud-button.tsx";

export function AttemptFailure({
    approval,
    code,
    message,
}: {
    readonly approval: { readonly kind: "bot-approval"; readonly botId: string } | { readonly kind: "unavailable" };
    readonly code: string;
    readonly message: string;
}) {
    const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
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
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <input
                            aria-label="Agent approval command"
                            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onFocus={(event) => event.currentTarget.select()}
                            readOnly
                            value={command}
                        />
                        <Button
                            onClick={() => {
                                if (navigator.clipboard === undefined) {
                                    setCopy("failed");
                                    return;
                                }
                                void navigator.clipboard.writeText(command).then(
                                    () => setCopy("copied"),
                                    () => setCopy("failed"),
                                );
                            }}
                            variant="outline"
                        >
                            {copy === "copied" ? (
                                <Check aria-hidden="true" className="size-4" />
                            ) : (
                                <Copy aria-hidden="true" className="size-4" />
                            )}
                            {copy === "copied" ? "Copied" : "Copy command"}
                        </Button>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground" role="status">
                        {copy === "failed"
                            ? "Select the command above and copy it manually."
                            : "After approval, resend your message here. Your agent and this session stay the same."}
                    </p>
                </div>
            )}
        </div>
    );
}
