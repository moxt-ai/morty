import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { Button } from "../../components/ui/cloud-button.tsx";
import type { NewDeviceNoticeStore } from "../../view-models/chat/new-device-notice-store.ts";

function joinedAt(time: string): string {
    return new Date(time).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Tells the owner that a device joined their computer, and how to end its access if they did not add it. */
export function NewDeviceNotice({ store }: { readonly store: StoreApi<NewDeviceNoticeStore> }) {
    const { state, onAttach, dismiss } = useStore(store);
    return (
        <div className="contents" ref={onAttach}>
            {state.kind === "notice" && (
                <section
                    aria-label="New device connected"
                    className="fixed top-3 left-1/2 z-[100] w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-border bg-background px-4 py-3 text-sm shadow-lg"
                    role="status"
                >
                    <p className="font-medium">
                        {state.devices.length === 1
                            ? "A new device connected to your computer"
                            : `${state.devices.length.toString()} new devices connected to your computer`}
                    </p>
                    <ul className="mt-1 text-muted-foreground">
                        {state.devices.map((device) => (
                            <li key={`${device.joinedAt}:${device.label ?? ""}`}>
                                {device.label ?? "Unknown browser"}, joined {joinedAt(device.joinedAt)}
                            </li>
                        ))}
                    </ul>
                    <p className="mt-2 text-muted-foreground">
                        Not you? Ask the agent on your computer to revoke all access. Every device that joined through a
                        link is disconnected at once.
                    </p>
                    <div className="mt-3 flex justify-end">
                        <Button onClick={dismiss} size="sm">
                            Got it
                        </Button>
                    </div>
                </section>
            )}
        </div>
    );
}
