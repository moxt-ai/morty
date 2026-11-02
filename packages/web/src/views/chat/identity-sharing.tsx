import type { StoreApi } from "zustand";
import { CopyLinkButton } from "../../components/chat/copy-link-button.tsx";
import { MortyAlert } from "../../components/ui/morty-alert.tsx";
import { dataTestId } from "../../data-testid.ts";
import { formatMoment } from "../../view-models/chat/access-presentation.ts";
import type { IdentitySharingStore } from "../../view-models/chat/identity-sharing-store.ts";
import { useExternalStore } from "../../view-models/external-store.ts";

/** Renders the sharing dialog's transfer, whose store is created when the dialog opens. */
export function IdentitySharing({ store }: { readonly store: StoreApi<IdentitySharingStore> }) {
    const state = useExternalStore(store, (state) => state.state);
    return (
        <div className="space-y-4">
            <MortyAlert tone="warning">
                Anyone who opens this link can view and control every session on this computer.
            </MortyAlert>
            {state.kind === "loading" && <p role="status">Creating secure QR code…</p>}
            {state.kind === "failed" && <p role="alert">Could not create a sharing link.</p>}
            {state.kind === "ready" && (
                <div className="space-y-4 text-center" data-testid={dataTestId.identitySharing}>
                    <img className="mx-auto size-56" src={state.image} alt="Continue on another device QR code" />
                    <CopyLinkButton url={state.transfer.url} />
                    <p className="text-xs leading-5 text-muted-foreground">
                        Works for one device until {formatMoment(state.transfer.expiresAt)}. That device keeps access
                        until {formatMoment(state.transfer.accessExpiresAt)}.
                    </p>
                </div>
            )}
        </div>
    );
}
