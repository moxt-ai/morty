import { ArrowUpRight, X } from "lucide-react";
import { Button } from "@/components/ui/cloud-button";
import { MortyAlert } from "@/components/ui/morty-alert";

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
        <section aria-label="Continue your work here" className="relative">
            <MortyAlert
                className="pr-10"
                description={
                    <>
                        Check its progress, send your next instruction, or respond to requests here.
                        {canSuggestProgress && (
                            <div className="mt-3">
                                <Button
                                    className="gap-1.5 min-h-11 md:min-h-9"
                                    onClick={onSuggestProgress}
                                    size="sm"
                                    variant="outline"
                                >
                                    Ask for a progress update
                                    <ArrowUpRight aria-hidden="true" className="size-3.5" />
                                </Button>
                                <p className="mt-1.5">Adds a draft for you to review and send.</p>
                            </div>
                        )}
                    </>
                }
                tone="info"
            >
                Your original session is open.
            </MortyAlert>
            <Button
                aria-label="Dismiss getting started tip"
                className="absolute top-1.5 right-1.5 text-muted-foreground"
                onClick={onDismiss}
                size="icon"
                variant="ghost"
            >
                <X aria-hidden="true" className="size-4" />
            </Button>
        </section>
    );
}
