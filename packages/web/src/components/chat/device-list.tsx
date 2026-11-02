import { MonitorSmartphone } from "lucide-react";
import { cn } from "../../lib/utils.ts";

/** Devices that hold access to the computer, each named on its own line with when and how it joined below. */
export function DeviceList({
    className,
    devices,
    label,
}: {
    readonly className?: string;
    readonly devices: readonly { readonly name: string; readonly detail: string }[];
    readonly label: string;
}) {
    return (
        <ul aria-label={label} className={cn("space-y-2", className)}>
            {devices.map((device, index) => (
                <li className="flex items-start gap-2.5" key={`${index.toString()}:${device.name}:${device.detail}`}>
                    <MonitorSmartphone aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{device.name}</p>
                        <p className="text-xs text-muted-foreground">{device.detail}</p>
                    </div>
                </li>
            ))}
        </ul>
    );
}
