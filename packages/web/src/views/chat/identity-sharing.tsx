import type { StoreApi } from "zustand";
import { CopyLinkButton } from "../../components/chat/copy-link-button.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { IdentitySharingStore } from "../../view-models/chat/identity-sharing-store.ts";
import { useExternalStore } from "../../view-models/external-store.ts";

/** Renders the sharing dialog's transfer, whose store is created when the dialog opens. */
export function IdentitySharing({ store }: { readonly store: StoreApi<IdentitySharingStore> }) {
    const state = useExternalStore(store, (state) => state.state);
    if (state.kind === "loading") {
        return <p role="status">Creating secure QR code…</p>;
    }
    if (state.kind === "failed") {
        return <p role="alert">Could not create a sharing link.</p>;
    }
    return (
        <div className="space-y-4 text-center" data-testid={dataTestId.identitySharing}>
            <img className="mx-auto size-56" src={state.image} alt="Continue on another device QR code" />
            <CopyLinkButton url={state.transfer.url} />
            <p className="text-xs leading-5 text-muted-foreground">
                New devices can join until {new Date(state.transfer.expiresAt).toLocaleString()}.
            </p>
        </div>
    );
}
