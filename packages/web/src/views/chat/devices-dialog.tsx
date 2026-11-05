import { Laptop } from "lucide-react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { DeviceSummary } from "../../components/chat/device-list.tsx";
import { topNoticeActionClassName } from "../../components/chat/top-notice.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { ExternalLink } from "../../components/ui/external-link.tsx";
import { textLinkClassName } from "../../components/ui/text-link.ts";
import { cn } from "../../lib/utils.ts";
import type { LinkedDevice } from "../../services/identity/anonymous-identity-api.ts";
import type { AccessExpiryStore } from "../../view-models/chat/access-expiry-store.ts";
import { describeLinkedDevice, formatMomentNumeric } from "../../view-models/chat/access-presentation.ts";
import type { DeviceAccessStore, DisconnectTarget } from "../../view-models/chat/device-access-store.ts";
import type { LinkedDevicesStore } from "../../view-models/chat/linked-devices-store.ts";
import { mortyRepository } from "../morty-repository.ts";

const dataPolicy = `${mortyRepository}#what-morty-does-with-your-data`;

const deviceGroupCardClassName =
    "overflow-hidden rounded-[20px] border border-white bg-card px-3.5 py-1 shadow-module sm:px-3";
const deviceGroupRowClassName = "py-3";
const deviceGroupDividerClassName = "border-t border-border/60";
const sectionHeadingClassName = "mb-2 px-0.5 text-12 font-medium leading-4 text-morty-text-3";
const dialogBodyClassName = "space-y-5 px-3 pb-4 sm:px-5 sm:pb-5";

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
        <div className="mt-3 rounded-[16px] border border-border/80 bg-morty-fill-opacity-1 px-3.5 py-3 text-13 leading-5">
            <p className="text-foreground">{question}</p>
            {disconnection.kind === "failed" && (
                <p className="mt-2 text-destructive" role="alert">
                    We couldn't confirm it was disconnected. Try again.
                </p>
            )}
            <div className="mt-3 flex justify-end gap-2">
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
    const until = term.kind !== "known" ? null : term.expiresAt === null ? null : formatMomentNumeric(term.expiresAt);
    return (
        <DeviceSummary
            device={{
                name: "This browser",
                details:
                    until === null
                        ? term.kind === "known" && term.expiresAt === null
                            ? [{ kind: "text", text: "No time limit" }]
                            : []
                        : [{ kind: "fields", fields: [{ label: "Until", value: until }] }],
            }}
        />
    );
}

function OtherDevicesBody({
    list,
    refresh,
    row,
}: {
    readonly list: LinkedDevicesStore["state"];
    readonly refresh: () => void;
    readonly row: (device: LinkedDevice) => ReactNode;
}) {
    if (list.devices === null && !list.failed) {
        return (
            <p className={cn(deviceGroupRowClassName, "text-13 text-morty-text-3")} role="status">
                Checking which devices have access…
            </p>
        );
    }
    if (list.failed) {
        return (
            <div className={cn(deviceGroupRowClassName, "flex items-center justify-between gap-3")} role="alert">
                <span className="text-13 text-morty-text-3">We couldn't load your devices.</span>
                <Button className={topNoticeActionClassName} onClick={refresh} size="sm" variant="ghost">
                    Try again
                </Button>
            </div>
        );
    }
    if (list.devices !== null && list.devices.length === 0) {
        return <p className={cn(deviceGroupRowClassName, "text-13 text-morty-text-3")}>No other device has access.</p>;
    }
    return (
        <ul className="divide-y divide-border/60">
            {list.devices
                ?.toSorted((left, right) => Date.parse(right.joinedAt) - Date.parse(left.joinedAt))
                .map((device) => (
                    <li className={deviceGroupRowClassName} key={device.id}>
                        {row(device)}
                    </li>
                ))}
        </ul>
    );
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
            <>
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
            </>
        );
    };
    return (
        <Dialog
            variant="devicesAccess"
            description="Who can use your computer from Morty, and for how long."
            onClose={close}
            title="Devices with access"
        >
            <div className={dialogBodyClassName}>
                {state.disconnected !== null && (
                    <p
                        className="rounded-[16px] border border-primary/20 bg-primary/5 px-3.5 py-3 text-13 leading-5 text-foreground"
                        role="status"
                    >
                        {state.disconnected.kind === "device"
                            ? `${state.disconnected.name} can no longer use your computer.`
                            : "Other devices can no longer use your computer, and links you shared that no one opened stop working."}
                        {state.disconnected.openWindows === "unconfirmed" &&
                            " Chat windows already open on them may keep working for up to 15 minutes; disconnecting again retries closing them."}
                    </p>
                )}

                <ul aria-label="Devices with access" className="space-y-5">
                    <li>
                        <h3 className={sectionHeadingClassName}>Always here</h3>
                        <div className={deviceGroupCardClassName}>
                            <div className={deviceGroupRowClassName}>
                                {accessExpiry === null ? (
                                    <DeviceSummary device={{ name: "This browser", details: [] }} />
                                ) : (
                                    <ThisBrowser accessExpiry={accessExpiry} />
                                )}
                            </div>
                            <div className={cn(deviceGroupDividerClassName, deviceGroupRowClassName)}>
                                <DeviceSummary
                                    device={{
                                        name: computerName || "Your computer",
                                        details: [{ kind: "text", text: "Always keeps access · can disconnect all" }],
                                    }}
                                    icon={Laptop}
                                />
                            </div>
                        </div>
                    </li>
                    <li>
                        <h3 className={sectionHeadingClassName}>Shared from links</h3>
                        <div className={deviceGroupCardClassName}>
                            <OtherDevicesBody list={list} refresh={refresh} row={row} />
                        </div>
                    </li>
                </ul>

                <div className="border-t border-border/60 pt-4">
                    {targets(state.disconnection, others) ? (
                        <Confirmation
                            disconnection={state.disconnection}
                            onCancel={cancel}
                            onConfirm={() => void confirm(signal())}
                            question="Disconnect every other device? They lose access right away, and links you shared that no one opened stop working. This browser and your computer keep access."
                        />
                    ) : (
                        <Button
                            className={cn(topNoticeActionClassName, "w-full sm:w-auto")}
                            disabled={state.disconnection.kind === "disconnecting"}
                            onClick={() => request(others)}
                            variant="outline"
                        >
                            Disconnect other devices
                        </Button>
                    )}
                </div>

                <details className="group rounded-[16px] border border-border/60 bg-morty-fill-opacity-1 px-3.5 py-3 text-13 leading-5 text-morty-text-3">
                    <summary className="cursor-pointer list-none font-medium text-foreground marker:content-none [&::-webkit-details-marker]:hidden">
                        <span className="inline-flex items-center gap-1.5">
                            How access works
                            <span
                                aria-hidden="true"
                                className="text-morty-text-3 transition-transform group-open:rotate-180"
                            >
                                ▾
                            </span>
                        </span>
                    </summary>
                    <ul className="mt-3 space-y-2 border-t border-border/60 pt-3 pl-0">
                        <li className="flex gap-2">
                            <span aria-hidden="true" className="text-copy-secondary">
                                ·
                            </span>
                            <span>Links work once, within 10 minutes.</span>
                        </li>
                        <li className="flex gap-2">
                            <span aria-hidden="true" className="text-copy-secondary">
                                ·
                            </span>
                            <span>You choose how long a device keeps access, from 1 hour to 30 days.</span>
                        </li>
                        <li className="flex gap-2">
                            <span aria-hidden="true" className="text-copy-secondary">
                                ·
                            </span>
                            <span>Disconnect any device here. Your computer always keeps access.</span>
                        </li>
                        <li className="flex gap-2">
                            <span aria-hidden="true" className="text-copy-secondary">
                                ·
                            </span>
                            <span>Morty records the approximate city a device joined from, never its IP address.</span>
                        </li>
                        <li className="flex gap-2">
                            <span aria-hidden="true" className="text-copy-secondary">
                                ·
                            </span>
                            <span>Your conversation history stays on your computer.</span>
                        </li>
                        <li className="flex gap-2">
                            <span aria-hidden="true" className="text-copy-secondary">
                                ·
                            </span>
                            <span>
                                Messages pass through Morty's relay and are not end-to-end encrypted.{" "}
                                <ExternalLink className={textLinkClassName} href={dataPolicy}>
                                    How Morty handles data
                                </ExternalLink>
                            </span>
                        </li>
                    </ul>
                </details>
            </div>
        </Dialog>
    );
}
