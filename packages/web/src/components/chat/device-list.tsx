import { MonitorSmartphone } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

export interface DeviceDescription {
    readonly name: string;
    readonly details: readonly string[];
}

/** One device that holds access to the computer: its name, then a line for each detail. */
export function DeviceSummary({ device, action }: { readonly device: DeviceDescription; readonly action?: ReactNode }) {
    return (
        <div className="flex items-start gap-2.5">
            <MonitorSmartphone aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{device.name}</p>
                {device.details.map((detail) => (
                    <p className="text-xs text-muted-foreground" key={detail}>
                        {detail}
                    </p>
                ))}
            </div>
            {action}
        </div>
    );
}

/** Devices that hold access to the computer, one summary each. */
export function DeviceList({
    className,
    devices,
    label,
}: {
    readonly className?: string;
    readonly devices: readonly DeviceDescription[];
    readonly label: string;
}) {
    return (
        <ul aria-label={label} className={cn("space-y-2", className)}>
            {devices.map((device, index) => (
                <li key={`${index.toString()}:${device.name}`}>
                    <DeviceSummary device={device} />
                </li>
            ))}
        </ul>
    );
}
