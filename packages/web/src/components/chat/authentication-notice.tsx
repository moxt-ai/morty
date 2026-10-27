import { KeyRound } from "lucide-react";

export interface AuthenticationGuidance {
    readonly title: string;
    readonly description: string;
    readonly steps: readonly string[];
}

export function AuthenticationNotice({
    guidance,
    code,
    message,
}: {
    readonly guidance: AuthenticationGuidance;
    readonly code: string;
    readonly message: string;
}) {
    return (
        <div
            className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-4 text-sm [overflow-wrap:anywhere]"
            role="alert"
        >
            <div className="flex items-start gap-2.5">
                <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
                <p className="font-medium">{guidance.title}</p>
            </div>
            <p className="mt-2 leading-relaxed text-muted-foreground">{guidance.description}</p>
            <details className="mt-3">
                <summary className="cursor-pointer py-2 font-medium outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring">
                    View steps
                </summary>
                <ol className="mt-2 list-decimal space-y-2 pl-5 leading-relaxed">
                    {guidance.steps.map((step) => (
                        <li key={step}>{step}</li>
                    ))}
                </ol>
                <p className="mt-3 text-muted-foreground">Your draft stays here. Nothing will be sent automatically.</p>
            </details>
            <details className="mt-2 border-t border-amber-500/15 pt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer py-2 outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring">
                    Technical details
                </summary>
                <p className="mt-2 whitespace-pre-wrap">{message}</p>
                <p className="mt-2 font-mono">{code}</p>
            </details>
        </div>
    );
}
