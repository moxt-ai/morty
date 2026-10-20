import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { dataTestId } from "../../data-testid.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import { createIdentitySharingStore } from "../../view-models/chat/identity-sharing-store.ts";
import type { OpenMobiusSession } from "../../view-models/chat/open-session.ts";

export function IdentitySharing({
    createTransfer,
    session,
}: {
    readonly createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>;
    readonly session: OpenMobiusSession | null;
}) {
    const [store] = useState(() => createIdentitySharingStore(createTransfer, session));
    const { load, state } = useStore(store);
    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);

    if (state.kind === "loading") {
        return <p role="status">Creating secure QR code…</p>;
    }
    if (state.kind === "failed") {
        return <p role="alert">Could not create a sharing link.</p>;
    }
    return (
        <div className="space-y-4 text-center" data-testid={dataTestId.identitySharing}>
            <img className="mx-auto size-56" src={state.image} alt="Continue your work QR code" />
            <a
                className="block break-all font-mono text-xs text-primary underline underline-offset-4"
                href={state.transfer.url}
                target="_blank"
                rel="noreferrer"
                aria-label="Open sharing link"
            >
                {state.transfer.url}
            </a>
            {state.handoff.kind === "available" ? (
                <div className="space-y-2 text-left">
                    <p className="text-sm font-medium">Let another agent take over</p>
                    <p className="text-xs leading-5 text-muted-foreground">
                        Give another agent this prompt with your goals. It can use curl to read the instructions and
                        continue this session through the same link.
                    </p>
                    <textarea
                        aria-label="Agent handoff prompt"
                        readOnly
                        value={state.handoff.prompt}
                        rows={5}
                        className="w-full resize-none rounded-md border border-border bg-muted/40 p-3 text-xs leading-5"
                        onFocus={(event) => event.currentTarget.select()}
                    />
                </div>
            ) : (
                <p className="text-xs leading-5 text-muted-foreground">
                    Open a conversation to generate a link that another agent can use to take it over.
                </p>
            )}
            <p className="text-xs leading-5 text-muted-foreground">
                This link expires {new Date(state.transfer.expiresAt).toLocaleString()}. Remote access remains active
                until you end it.
            </p>
        </div>
    );
}
