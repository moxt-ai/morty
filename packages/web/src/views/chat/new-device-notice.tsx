import { ShieldAlert } from "lucide-react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { DeviceList } from "../../components/chat/device-list.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { describeLinkedDevice } from "../../view-models/chat/access-presentation.ts";
import { type LinkedDevicesStore, newDevicesSince } from "../../view-models/chat/linked-devices-store.ts";
import { SidebarAccessNoticeCard, sidebarAccessNoticeActionClassName } from "./access-term.tsx";

/** Tells the owner that a device joined their computer, and lets them disconnect it if they did not add it. */
export function NewDeviceNotice({
    store,
    onReviewDevices,
}: {
    readonly store: StoreApi<LinkedDevicesStore>;
    /** Opens the devices with access, where any of them can be disconnected; null when this page cannot. */
    readonly onReviewDevices: (() => void) | null;
}) {
    const { state, acknowledge } = useStore(store);
    const joined = newDevicesSince(state.devices, state.seenAt);
    if (joined.length === 0) {
        return null;
    }
    return (
        <SidebarAccessNoticeCard
            actions={
                <>
                    <Button className={sidebarAccessNoticeActionClassName} onClick={acknowledge} size="xs">
                        Got it
                    </Button>
                    {onReviewDevices !== null && (
                        <Button
                            className={sidebarAccessNoticeActionClassName}
                            onClick={onReviewDevices}
                            size="xs"
                            variant="outline"
                        >
                            Review devices
                        </Button>
                    )}
                </>
            }
            body={
                <DeviceList
                    devices={joined.map((device) => describeLinkedDevice(device, "notice"))}
                    label="New devices"
                    layout="notice"
                />
            }
            detail={
                onReviewDevices === null
                    ? "Not you? Ask your agent to revoke all link access."
                    : "Not you? Disconnect it in Devices."
            }
            icon={ShieldAlert}
            label="New device connected"
            title={joined.length === 1 ? "New device connected" : `${joined.length.toString()} new devices connected`}
        />
    );
}
