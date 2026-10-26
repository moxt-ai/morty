import { dataTestId } from "@/data-testid";
import type { SessionFailure } from "@/view-models/chat/session-failure";

export function SessionLoadFailure({ failure }: Readonly<{ failure: SessionFailure }>) {
    return (
        <div
            className="grid max-w-lg justify-items-center gap-2 text-center [overflow-wrap:anywhere]"
            data-testid={dataTestId.sessionLoadFailure}
            role="alert"
        >
            <h2 className="font-medium">{failure.title}</h2>
            <p className="max-w-sm text-sm leading-6 text-muted-foreground">{failure.description}</p>
            <details className="w-full text-xs text-muted-foreground">
                <summary className="cursor-pointer py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Technical details
                </summary>
                <p className="mt-2 whitespace-pre-wrap">{failure.diagnostic.message}</p>
                {failure.diagnostic.code !== null && <p className="mt-2 font-mono">{failure.diagnostic.code}</p>}
            </details>
        </div>
    );
}
