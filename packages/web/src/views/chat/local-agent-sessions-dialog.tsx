import type { NativeSessionEntry } from "@moxt-ai/mobius-protocol";
import { Button } from "../../components/ui/cloud-button.tsx";

export function LocalAgentSessionsDialog({
    entries,
    onClose,
    onImport,
}: {
    readonly entries: readonly NativeSessionEntry[] | null;
    readonly onClose: () => void;
    readonly onImport: (entry: NativeSessionEntry) => Promise<void>;
}) {
    return (
        <>
            {entries !== null && (
                <div
                    aria-label="Local Agent sessions"
                    className="fixed inset-0 z-50 grid place-items-center bg-black/30"
                    role="dialog"
                >
                    <div className="max-h-[80vh] w-[min(600px,90vw)] overflow-y-auto rounded-xl bg-card p-5 shadow-xl">
                        <div className="mb-3 flex items-center justify-between">
                            <h2 className="font-semibold">Local Agent sessions</h2>
                            <Button onClick={() => onClose()} variant="outline">
                                Close
                            </Button>
                        </div>
                        {entries.length === 0 && <p>No local sessions were found.</p>}
                        {entries.map((entry) => (
                            <button
                                className="block w-full rounded-lg p-3 text-left hover:bg-muted"
                                key={entry.entryId}
                                onClick={() => void onImport(entry)}
                                type="button"
                            >
                                <span className="block text-sm font-medium">{entry.title}</span>
                                <span className="block text-xs text-muted-foreground">{entry.directoryLabel}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </>
    );
}
