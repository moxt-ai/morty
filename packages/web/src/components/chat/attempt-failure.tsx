import type { MobiusMessagePage } from "@moxt-ai/mobius-sdk";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/cloud-button.tsx";

export function AttemptFailure({
    attempt,
    botId,
}: {
    readonly attempt: MobiusMessagePage["messages"][number]["attempt"];
    readonly botId: string;
}) {
    const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
    if (attempt.kind !== "failed") {
        return null;
    }
    const message =
        "message" in attempt && typeof attempt.message === "string"
            ? attempt.message
            : "The agent could not complete this message.";
    const code = "code" in attempt && typeof attempt.code === "string" ? attempt.code : "";
    const command =
        code === "binding_not_approved" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(botId)
            ? `npx --yes @moxt-ai/mobius@latest bot approve --bot ${botId}`
            : "";
    return (
        <div
            role="alert"
            className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm [overflow-wrap:anywhere]"
        >
            <p className="font-medium text-destructive">Response failed</p>
            <p className="mt-1 whitespace-pre-wrap">{message}</p>
            {code !== "" && <p className="mt-2 font-mono text-xs text-muted-foreground">{code}</p>}
            {command !== "" && (
                <div className="mt-4 border-t border-destructive/20 pt-4">
                    <p>Run this command in a terminal on the machine running your Bot:</p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <input
                            aria-label="Bot approval command"
                            readOnly
                            value={command}
                            onFocus={(event) => event.currentTarget.select()}
                            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <Button
                            variant="outline"
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
                        >
                            {copy === "copied" ? (
                                <Check className="size-4" aria-hidden="true" />
                            ) : (
                                <Copy className="size-4" aria-hidden="true" />
                            )}
                            {copy === "copied" ? "Copied" : "Copy command"}
                        </Button>
                    </div>
                    <p role="status" className="mt-2 text-xs text-muted-foreground">
                        {copy === "failed"
                            ? "Select the command above and copy it manually."
                            : "After approval, resend your message here. Your Bot and this conversation stay the same."}
                    </p>
                </div>
            )}
        </div>
    );
}
