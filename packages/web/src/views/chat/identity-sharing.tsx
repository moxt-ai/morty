import type { StoreApi } from "zustand";
import { useStore } from "zustand";
import { dataTestId } from "../../data-testid.ts";
import type { IdentitySharingStore } from "../../view-models/chat/identity-sharing-store.ts";

/** Renders the sharing dialog's transfer, whose store is created when the dialog opens. */
export function IdentitySharing({ store }: { readonly store: StoreApi<IdentitySharingStore> }) {
    const state = useStore(store, (state) => state.state);
    if (state.kind === "loading") {
        return <p role="status">Creating secure QR code…</p>;
    }
    if (state.kind === "failed") {
        return <p role="alert">Could not create a sharing link.</p>;
    }
    return (
        <div className="space-y-4 text-center" data-testid={dataTestId.identitySharing}>
            <img className="mx-auto size-56" src={state.image} alt="Continue on another device QR code" />
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
                New devices can join until {new Date(state.transfer.expiresAt).toLocaleString()}.
            </p>
        </div>
    );
}
