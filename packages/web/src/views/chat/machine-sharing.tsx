import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { dataTestId } from "../../data-testid.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import { createMachineSharingStore } from "../../view-models/chat/machine-sharing-store.ts";

export function MachineSharing({
    createTransfer,
}: {
    readonly createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>;
}) {
    const [store] = useState(() => createMachineSharingStore(createTransfer));
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
        <div className="space-y-4 text-center" data-testid={dataTestId.machineSharing}>
            <img className="mx-auto size-56" src={state.image} alt="Machine sharing QR code" />
            <a
                className="block break-all font-mono text-xs text-primary underline underline-offset-4"
                href={state.transfer.url}
                target="_blank"
                rel="noreferrer"
                aria-label="Open sharing link"
            >
                {state.transfer.url}
            </a>
            <p className="text-xs leading-5 text-muted-foreground">
                This link expires {new Date(state.transfer.expiresAt).toLocaleString()}. Remote access remains active
                until you end it.
            </p>
        </div>
    );
}
