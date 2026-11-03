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

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** Where a device joined from, as approximate as Cloudflare's location of its connection. */
function joinedNear(location: LinkedDevice["location"]): string | null {
    const country = location?.country == null ? null : (regionNames.of(location.country) ?? location.country);
    const city = location?.city ?? null;
    if (city !== null && country !== null) {
        return `Near ${city}, ${country}`;
    }
    if (city !== null || country !== null) {
        return `Near ${city ?? country}`;
    }
    return null;
}

/**
 * How a device that holds access through a link reads in lists: its name, then when and roughly where it joined, then
 * who added it and until when it keeps access.
 */
export function describeLinkedDevice(device: LinkedDevice): {
    readonly name: string;
    readonly details: readonly string[];
} {
    const joined = [`Joined ${formatMoment(device.joinedAt)}`, joinedNear(device.location)];
    const term = [addedBy(device), `Until ${formatMoment(device.accessExpiresAt)}`];
    return {
        name: device.label ?? "Unknown browser",
        details: [joined, term].map((parts) => parts.filter((part) => part !== null).join(" · ")),
    };
}
