import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import type { OtherDevicesStore } from "../../view-models/chat/other-devices-store.ts";

/** Confirms disconnecting every other device, then reports what that reached. */
export function OtherDevicesDialog({
    store,
    signal,
}: {
    readonly store: StoreApi<OtherDevicesStore>;
    readonly signal: () => AbortSignal;
}) {
    const { state, close, disconnect } = useStore(store);
    if (state.kind === "idle") {
        return null;
    }
    if (state.kind === "disconnected") {
        return (
            <Dialog title="Other devices disconnected" onClose={close}>
                <p className="text-sm text-muted-foreground">
                    {state.openWindows === "closed"
                        ? "They can no longer use your computer, and links you shared that no one has opened yet no longer work."
                        : "They can no longer use your computer, and links you shared that no one has opened yet no longer work. Chat windows already open on them could not be closed and may keep working for up to 15 minutes; disconnecting again retries closing them."}
                </p>
                <div className="mt-5 flex justify-end">
                    <Button onClick={close} variant="primary">
                        Done
                    </Button>
                </div>
            </Dialog>
        );
    }
    const disconnecting = state.kind === "disconnecting";
    return (
        <Dialog
            busy={disconnecting}
            title="Disconnect other devices?"
            description={
                <>
                    <span className="block">
                        Every other browser that joined through a link loses access now, and links you shared that no
                        one has opened yet stop working.
                    </span>
                    <span className="mt-2 block">
                        This browser and your computer keep access. Chat windows open here reconnect in a few seconds.
                    </span>
                </>
            }
            onClose={close}
        >
            {state.kind === "failed" && (
                <p className="mt-3 text-sm text-destructive" role="alert">
                    {state.message}
                </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
                <Button disabled={disconnecting} onClick={close} variant="ghost">
                    Cancel
                </Button>
                <Button disabled={disconnecting} onClick={() => void disconnect(signal())} variant="primary">
                    {disconnecting ? "Disconnecting…" : state.kind === "failed" ? "Try again" : "Disconnect"}
                </Button>
            </div>
        </Dialog>
    );
}
