import type { StoreApi } from "zustand";
import { CopyLinkButton } from "../../components/chat/copy-link-button.tsx";
import { MortyAlert } from "../../components/ui/morty-alert.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import { dataTestId } from "../../data-testid.ts";
import { type DeviceAccessDuration, deviceAccessDurations } from "../../services/identity/anonymous-identity-api.ts";
import { formatMoment } from "../../view-models/chat/access-presentation.ts";
import type { IdentitySharingStore } from "../../view-models/chat/identity-sharing-store.ts";
import { useExternalStore } from "../../view-models/external-store.ts";

const durationLabels: Readonly<Record<DeviceAccessDuration, string>> = {
    "1h": "1 hour",
    "1d": "1 day",
    "7d": "7 days",
    "30d": "30 days",
};
const durationOptions = deviceAccessDurations.map((value) => ({ value, label: durationLabels[value] }));

const shareMethodSectionTitleClassName = "text-sm font-medium text-foreground";
const shareMethodSubheadingClassName = "text-12 font-medium leading-4 text-morty-text-3";

/** Renders the sharing dialog's transfer, whose store is created when the dialog opens. */
export function IdentitySharing({ store }: { readonly store: StoreApi<IdentitySharingStore> }) {
    const state = useExternalStore(store, (state) => state.state);
    const choose = useExternalStore(store, (state) => state.choose);
    // The Worker states the duration a link grants; until the first link exists there is nothing to show.
    const duration = state.kind === "ready" ? state.transfer.accessDuration : state.duration;
    return (
        <div className="flex flex-col gap-4">
            <MortyAlert tone="warning">
                Anyone who opens this link can view and control every session on this computer.
            </MortyAlert>
            {duration !== null && (
                <div className="grid gap-2">
                    <p className="text-sm font-medium text-foreground">Device access</p>
                    <Select
                        label="Device access"
                        onValueChange={(value) => {
                            const chosen = deviceAccessDurations.find((option) => option === value);
                            if (chosen !== undefined) {
                                choose(chosen);
                            }
                        }}
                        options={durationOptions}
                        value={duration}
                    />
                </div>
            )}
            {state.kind === "loading" && <p role="status">Creating secure QR code…</p>}
            {state.kind === "failed" && <p role="alert">Could not create a sharing link.</p>}
            {state.kind === "ready" && (
                <div className="mt-2 space-y-4" data-testid={dataTestId.identitySharing}>
                    <div className="space-y-3">
                        <h3 className={shareMethodSectionTitleClassName}>Sharing method</h3>
                        <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-8 gap-y-3">
                            <p className={`col-start-1 row-start-1 ${shareMethodSubheadingClassName}`}>
                                QR code sharing
                            </p>
                            <p className={`col-start-3 row-start-1 ${shareMethodSubheadingClassName}`}>Link sharing</p>
                            <div className="col-start-1 row-start-2 shrink-0 rounded-lg bg-white p-3">
                                <img
                                    className="size-40 shrink-0"
                                    src={state.image}
                                    alt="Continue on another device QR code"
                                />
                            </div>
                            <div
                                aria-hidden="true"
                                className="col-start-2 row-start-2 flex min-h-0 shrink-0 flex-col items-center self-stretch"
                            >
                                <div className="min-h-0 w-[0.5px] flex-1 bg-border/60" />
                                <p className="py-2 text-11 font-medium uppercase tracking-wide text-morty-text-4">or</p>
                                <div className="min-h-0 w-[0.5px] flex-1 bg-border/60" />
                            </div>
                            <CopyLinkButton className="col-start-3 row-start-2 min-w-0" url={state.transfer.url} />
                        </div>
                    </div>
                    <p className="text-center text-xs leading-5 text-morty-text-3">
                        Works for one device until {formatMoment(state.transfer.expiresAt)}. That device keeps access
                        until {formatMoment(state.transfer.accessExpiresAt)}.
                        {state.transfer.accessLimitedBySharer &&
                            " This browser's own access ends then, so the device cannot keep it longer."}
                        {state.replacedEarlier && " The previous link no longer works."}
                    </p>
                </div>
            )}
        </div>
    );
}
