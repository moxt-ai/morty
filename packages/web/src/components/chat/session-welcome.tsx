import { ArrowUpRight, X } from "lucide-react";

export function SessionWelcome({
    canSuggestProgress,
    onDismiss,
    onSuggestProgress,
}: {
    readonly canSuggestProgress: boolean;
    readonly onDismiss: () => void;
    readonly onSuggestProgress: () => void;
}) {
    return (
        <section
            aria-label="Continue your work here"
            className="relative mt-0 rounded-xl border border-primary/15 bg-primary/5 p-4 pr-11"
        >
            <h2 className="text-sm font-medium text-foreground">Your original session is open.</h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
                Check its progress, send your next instruction, or respond to requests here.
            </p>
            {canSuggestProgress && (
                <div className="mt-3">
                    <button
                        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-primary/20 bg-card px-3 text-xs font-medium text-foreground outline-none hover:bg-primary/5 keyboard-focus:focus-visible:ring-2 keyboard-focus:focus-visible:ring-ring"
                        onClick={onSuggestProgress}
                        type="button"
                    >
                        Ask for a progress update
                        <ArrowUpRight aria-hidden="true" className="size-3.5" />
                    </button>
                    <p className="mt-1.5 text-xs text-muted-foreground">Adds a draft for you to review and send.</p>
                </div>
            )}
            <button
                aria-label="Dismiss getting started tip"
                className="absolute top-1 right-1 inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-primary/5 keyboard-focus:focus-visible:ring-2 keyboard-focus:focus-visible:ring-ring"
                onClick={onDismiss}
                type="button"
            >
                <X aria-hidden="true" className="size-4" />
            </button>
        </section>
    );
}
