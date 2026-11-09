export function AttemptFailure({ code, message }: { readonly code: string; readonly message: string }) {
    return (
        <div
            className="rounded-[24px] border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm [overflow-wrap:anywhere]"
            role="alert"
        >
            <p className="font-medium text-destructive">Response failed</p>
            <p className="mt-1 whitespace-pre-wrap">{message}</p>
            {code.length > 0 && <p className="mt-2 font-mono text-xs text-muted-foreground">{code}</p>}
        </div>
    );
}
