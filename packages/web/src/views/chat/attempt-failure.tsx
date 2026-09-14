import type { MobiusMessagePage } from "@moxt-ai/mobius-sdk/browser";

export function AttemptFailure({ attempt }: { readonly attempt: MobiusMessagePage["messages"][number]["attempt"] }) {
    if (attempt.kind !== "failed") {
        return null;
    }
    const message =
        "message" in attempt && typeof attempt.message === "string"
            ? attempt.message
            : "The agent could not complete this message.";
    const code = "code" in attempt && typeof attempt.code === "string" ? attempt.code : "";
    return (
        <div
            role="alert"
            className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm [overflow-wrap:anywhere]"
        >
            <p className="font-medium text-destructive">Response failed</p>
            <p className="mt-1 whitespace-pre-wrap">{message}</p>
            {code !== "" && <p className="mt-2 font-mono text-xs text-muted-foreground">{code}</p>}
        </div>
    );
}
