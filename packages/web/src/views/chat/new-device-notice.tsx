import { ShieldAlert } from "lucide-react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { DeviceList } from "../../components/chat/device-list.tsx";
import { topNoticeActionClassName, topNoticeCardClassName } from "../../components/chat/top-notice.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { describeLinkedDevice } from "../../view-models/chat/access-presentation.ts";
import type { NewDeviceNoticeStore } from "../../view-models/chat/new-device-notice-store.ts";

/** Tells the owner that a device joined their computer, and lets them disconnect it if they did not add it. */
export function NewDeviceNotice({
    store,
    onReviewDevices,
}: {
    readonly store: StoreApi<NewDeviceNoticeStore>;
    /** Opens the devices with access, where any of them can be disconnected; null when this page cannot. */
    readonly onReviewDevices: (() => void) | null;
}) {
    const { state, onAttach, dismiss } = useStore(store);
    return (
        <div className="contents" ref={onAttach}>
            {state.kind === "notice" && (
                <section aria-label="New device connected" className={topNoticeCardClassName} role="status">
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
                        {onReviewDevices === null
                            ? "Not you? Ask the agent on your computer to revoke all access. Every device that joined through a link is disconnected at once."
                            : "Not you? Review your devices and disconnect any you don't recognize."}
                    </p>
                    <div className="mt-3 flex justify-end gap-2">
                        {onReviewDevices !== null && (
                            <Button
                                className={topNoticeActionClassName}
                                onClick={onReviewDevices}
                                size="sm"
                                variant="ghost"
                            >
                                Review devices
                            </Button>
                        )}
                        <Button className={topNoticeActionClassName} onClick={dismiss} size="sm">
                            Got it
                        </Button>
                    </div>
                </section>
            )}
        </div>
    );
}
