import { ShieldAlert } from "lucide-react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { DeviceList } from "../../components/chat/device-list.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { describeLinkedDevice } from "../../view-models/chat/access-presentation.ts";
import type { NewDeviceNoticeStore } from "../../view-models/chat/new-device-notice-store.ts";

/** Tells the owner that a device joined their computer, and lets them disconnect it if they did not add it. */
export function NewDeviceNotice({
    store,
    onDisconnectOthers,
}: {
    readonly store: StoreApi<NewDeviceNoticeStore>;
    readonly onDisconnectOthers: (() => void) | null;
}) {
    const { state, onAttach, dismiss } = useStore(store);
    return (
        <div className="contents" ref={onAttach}>
            {state.kind === "notice" && (
                // Below the dialog overlay, so a confirmation it opens covers it instead of repeating its actions.
                <section
                    aria-label="New device connected"
                    className="fixed top-3 left-1/2 z-40 w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-border bg-background px-4 py-3 text-sm shadow-lg"
                    role="status"
                >
                    <p className="flex items-center gap-2 font-medium">
                        <ShieldAlert aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                        {state.devices.length === 1
                            ? "A new device connected to your computer"
                            : `${state.devices.length.toString()} new devices connected to your computer`}
                    </p>
                    <DeviceList
                        className="mt-3"
                        devices={state.devices.map(describeLinkedDevice)}
                        label="New devices"
                    />
                    <p className="mt-3 text-muted-foreground">
                        {onDisconnectOthers === null
                            ? "Not you? Ask the agent on your computer to revoke all access. Every device that joined through a link is disconnected at once."
                            : "Not you? Disconnect the other devices. This browser and your computer keep access."}
                    </p>
                    <div className="mt-3 flex justify-end gap-2">
                        {onDisconnectOthers !== null && (
                            <Button onClick={onDisconnectOthers} size="sm" variant="ghost">
                                Disconnect other devices
                            </Button>
                        )}
                        <Button onClick={dismiss} size="sm">
                            Got it
                        </Button>
                    </div>
                </section>
            )}
        </div>
    );
}
