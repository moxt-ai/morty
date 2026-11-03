import { Laptop } from "lucide-react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { DeviceSummary } from "../../components/chat/device-list.tsx";
import { topNoticeActionClassName } from "../../components/chat/top-notice.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { ExternalLink } from "../../components/ui/external-link.tsx";
import { textLinkClassName } from "../../components/ui/text-link.ts";
import type { LinkedDevice } from "../../services/identity/anonymous-identity-api.ts";
import type { AccessExpiryStore } from "../../view-models/chat/access-expiry-store.ts";
import { describeLinkedDevice, formatMoment } from "../../view-models/chat/access-presentation.ts";
import type { DeviceAccessStore, DisconnectTarget } from "../../view-models/chat/device-access-store.ts";
import type { LinkedDevicesStore } from "../../view-models/chat/linked-devices-store.ts";
import { mortyRepository } from "../morty-repository.ts";

const dataPolicy = `${mortyRepository}#what-morty-does-with-your-data`;

type OpenState = Extract<DeviceAccessStore["state"], { readonly kind: "open" }>;

function targets(disconnection: OpenState["disconnection"], target: DisconnectTarget): boolean {
    return (
        disconnection.kind !== "idle" &&
        disconnection.target.kind === target.kind &&
        (target.kind === "others" || (disconnection.target.kind === "device" && disconnection.target.id === target.id))
    );
}

/** The confirmation a disconnection asks for in place, with what it reaches; one at a time. */
function Confirmation({
    disconnection,
    question,
    onCancel,
    onConfirm,
}: {
    readonly disconnection: OpenState["disconnection"];
    readonly question: string;
    readonly onCancel: () => void;
    readonly onConfirm: () => void;
}) {
    const disconnecting = disconnection.kind === "disconnecting";
    return (
        <div className="mt-2 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
            <p>{question}</p>
            {disconnection.kind === "failed" && (
                <p className="mt-1 text-destructive" role="alert">
                    We couldn't confirm it was disconnected. Try again.
                </p>
            )}
            <div className="mt-2 flex justify-end gap-2">
                <Button
                    className={topNoticeActionClassName}
                    disabled={disconnecting}
                    onClick={onCancel}
                    size="sm"
                    variant="ghost"
                >
                    Cancel
                </Button>
                <Button
                    className={topNoticeActionClassName}
                    // The confirmation takes focus where it appears, so the keyboard answers it next.
                    ref={(node) => {
                        node?.focus();
                    }}
                    disabled={disconnecting}
                    onClick={onConfirm}
                    size="sm"
                    variant="primary"
                >
                    {disconnecting ? "Disconnecting…" : disconnection.kind === "failed" ? "Try again" : "Disconnect"}
                </Button>
            </div>
        </div>
    );
}

function ThisBrowser({ accessExpiry }: { readonly accessExpiry: StoreApi<AccessExpiryStore> }) {
    const term = useStore(accessExpiry, (model) => model.state);
    const until =
        term.kind !== "known"
            ? null
            : term.expiresAt === null
              ? "No time limit"
              : `Until ${formatMoment(term.expiresAt)}`;
    return <DeviceSummary device={{ name: "This browser", details: until === null ? [] : [until] }} />;
}

/**
 * Who can use this computer right now, and the way to take access away from any of them: one device, or all but
 * this browser and the computer. The computer always keeps access, so it can end everything shared from it.
 */
export function DevicesDialog({
    accessExpiry,
    computerName,
    devices,
    signal,
    store,
}: {
    readonly accessExpiry: StoreApi<AccessExpiryStore> | null;
    readonly computerName: string;
    /** The page's one list of the other devices with access. */
    readonly devices: StoreApi<LinkedDevicesStore>;
    readonly signal: () => AbortSignal;
    readonly store: StoreApi<DeviceAccessStore>;
}) {
    const { state, close, request, cancel, confirm } = useStore(store);
    const { state: list, refresh } = useStore(devices);
    if (state.kind === "closed") {
        return null;
    }
    const others: DisconnectTarget = { kind: "others" };
    const row = (device: LinkedDevice) => {
        const description = describeLinkedDevice(device);
        const target: DisconnectTarget = { kind: "device", id: device.id, name: description.name };
        return (
            <li className="py-3" key={device.id}>
                <DeviceSummary
                    action={
                        targets(state.disconnection, target) ? undefined : (
                            <Button
                                aria-label={`Disconnect ${description.name}`}
                                className={topNoticeActionClassName}
                                disabled={state.disconnection.kind === "disconnecting"}
                                onClick={() => request(target)}
                                size="sm"
                                variant="ghost"
                            >
                                Disconnect
                            </Button>
                        )
                    }
                    device={description}
                />
                {targets(state.disconnection, target) && (
                    <Confirmation
                        disconnection={state.disconnection}
                        onCancel={cancel}
                        onConfirm={() => void confirm(signal())}
                        question={`Disconnect ${description.name}? It loses access right away. Your open windows reconnect in a few seconds.`}
                    />
                )}
            </li>
        );
    };
    return (
        <Dialog onClose={close} title="Devices with access">
            {state.disconnected !== null && (
                <p className="mb-3 text-sm text-muted-foreground" role="status">
                    {state.disconnected.kind === "device"
                        ? `${state.disconnected.name} can no longer use your computer.`
                        : "Other devices can no longer use your computer, and links you shared that no one opened stop working."}
                    {state.disconnected.openWindows === "unconfirmed" &&
                        " Chat windows already open on them may keep working for up to 15 minutes; disconnecting again retries closing them."}
                </p>
            )}
            <ul aria-label="Devices with access" className="divide-y divide-border">
                <li className="py-3">
                    {accessExpiry === null ? (
                        <DeviceSummary device={{ name: "This browser", details: [] }} />
                    ) : (
                        <ThisBrowser accessExpiry={accessExpiry} />
                    )}
                </li>
                <li className="py-3">
                    <div className="flex items-start gap-2.5">
                        <Laptop aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-foreground">{computerName || "Your computer"}</p>
                            <p className="text-xs text-muted-foreground">
                                Always keeps access and can revoke everything
                            </p>
                        </div>
                    </div>
                </li>
                {
                    // The newest device first: the one the owner is most likely checking.
                    list.devices
                        ?.toSorted((left, right) => Date.parse(right.joinedAt) - Date.parse(left.joinedAt))
                        .map(row)
                }
            </ul>
            {list.devices === null && !list.failed && (
                <p className="mt-2 text-sm text-muted-foreground" role="status">
                    Checking which devices have access…
                </p>
            )}
            {list.failed && (
                <div className="mt-2 flex items-center justify-between gap-2 text-sm" role="alert">
                    <span className="text-muted-foreground">We couldn't load your devices.</span>
                    <Button className={topNoticeActionClassName} onClick={refresh} size="sm" variant="ghost">
                        Try again
                    </Button>
                </div>
            )}
            {list.devices !== null && list.devices.length === 0 && (
                <p className="mt-2 text-sm text-muted-foreground">No other device has access.</p>
            )}
            <div className="mt-4 border-t border-border pt-4">
                {targets(state.disconnection, others) ? (
                    <Confirmation
                        disconnection={state.disconnection}
                        onCancel={cancel}
                        onConfirm={() => void confirm(signal())}
                        question="Disconnect every other device? They lose access right away, and links you shared that no one opened stop working. This browser and your computer keep access."
                    />
                ) : (
                    <Button
                        className={topNoticeActionClassName}
                        disabled={state.disconnection.kind === "disconnecting"}
                        onClick={() => request(others)}
                        variant="ghost"
                    >
                        Disconnect other devices
                    </Button>
                )}
            </div>
            <details className="mt-4 text-sm text-muted-foreground">
                <summary className="cursor-pointer font-medium text-foreground">How access works</summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>Links work once, within 10 minutes.</li>
                    <li>You choose how long a device keeps access, from 1 hour to 30 days.</li>
                    <li>
                        You can disconnect any device here. Your computer always keeps access and can revoke everything.
                    </li>
                    <li>Morty records the approximate city a device joined from, never its IP address.</li>
                    <li>Your conversation history stays on your computer.</li>
                    <li>
                        Messages pass through Morty's relay and are not end-to-end encrypted.{" "}
                        <ExternalLink className={textLinkClassName} href={dataPolicy}>
                            How Morty handles data
                        </ExternalLink>
                    </li>
                </ul>
            </details>
        </Dialog>
    );
}
