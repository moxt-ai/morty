import type { LinkedDevice } from "../../services/identity/anonymous-identity-api.ts";

const momentFormat = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

/** A moment the Worker reported, to the minute: when a device joined, or when a link or access ends. */
export function formatMoment(time: string): string {
    return momentFormat.format(new Date(time));
}

function addedBy(device: LinkedDevice): string | null {
    switch (device.addedBy?.kind) {
        case "computer":
            return "Added from your computer";
        case "recovery":
            return "Added with recovery access";
        case "device":
            return `Added from ${device.addedBy.label ?? "another browser"}`;
        case undefined:
            return null;
    }
}

/** How a device that holds access through a link reads in lists: its name, then when and how it joined. */
export function describeLinkedDevice(device: LinkedDevice): { readonly name: string; readonly detail: string } {
    const sharer = addedBy(device);
    const joined = `Joined ${formatMoment(device.joinedAt)}`;
    return { name: device.label ?? "Unknown browser", detail: sharer === null ? joined : `${joined} · ${sharer}` };
}
