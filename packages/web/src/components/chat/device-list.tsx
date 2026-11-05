import { type LucideIcon, MonitorSmartphone } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import type { DeviceDescription, DeviceDetailField } from "../../view-models/chat/access-presentation.ts";

export type { DeviceDescription };

const deviceDetailTableClassName = "mt-1 w-full border-collapse text-xs text-muted-foreground";
const deviceDetailLabelClassName = "py-0.5 pr-2 text-left align-top font-normal text-morty-text-3";
const deviceDetailValueClassNameBase = "min-w-0 py-0.5 text-left align-top [overflow-wrap:anywhere] text-foreground/80";
function deviceDetailValueClassName(label: string, layout: "default" | "notice"): string {
    const numeric = label === "Joined" || label === "Until";
    return cn(
        deviceDetailValueClassNameBase,
        numeric &&
            (layout === "notice"
                ? "font-mono tabular-nums tracking-tight"
                : "font-mono text-[11px] tabular-nums leading-4 tracking-tight"),
    );
}

const noticeDeviceInkClassName = "text-foreground/80";
const noticeIconColumnClassName = cn("size-3.5 shrink-0", noticeDeviceInkClassName);

function DeviceDetailFields({
    fields,
    indentDetails,
    layout,
}: {
    readonly fields: readonly DeviceDetailField[];
    readonly indentDetails: boolean;
    readonly layout: "default" | "notice";
}) {
    return (
        <table
            className={cn(
                deviceDetailTableClassName,
                layout === "notice" ? "table-fixed" : "table-auto",
                indentDetails && "ml-6",
            )}
        >
            <tbody>
                {fields.map((field) => (
                    <tr key={`${field.label}:${field.value}`}>
                        <th
                            className={cn(
                                deviceDetailLabelClassName,
                                layout === "notice" ? "w-[4.25rem]" : "whitespace-nowrap",
                            )}
                            scope="row"
                        >
                            {field.label}
                        </th>
                        <td className={deviceDetailValueClassName(field.label, layout)}>{field.value}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

/** One device that holds access to the computer: its name, then a line for each detail. */
export function DeviceSummary({
    device,
    action,
    icon: Icon = MonitorSmartphone,
    layout = "default",
}: {
    readonly device: DeviceDescription;
    readonly action?: ReactNode;
    readonly icon?: LucideIcon;
    /** `notice` lines the device icon up with the detail table in sidebar access notices. */
    readonly layout?: "default" | "notice";
}) {
    const indentDetails = layout === "default";
    const details = device.details.map((detail, index) =>
        detail.kind === "text" ? (
            <p
                className={cn("text-xs text-muted-foreground", indentDetails && "pl-6")}
                key={`text:${index.toString()}`}
            >
                {detail.text}
            </p>
        ) : (
            <DeviceDetailFields
                fields={detail.fields}
                indentDetails={indentDetails}
                key={`fields:${index.toString()}`}
                layout={layout}
            />
        ),
    );

    if (layout === "notice") {
        return (
            <div className="flex items-start gap-2.5">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        <Icon aria-hidden="true" className={noticeIconColumnClassName} />
                        <p className={cn("min-w-0 flex-1 text-12 font-semibold leading-4", noticeDeviceInkClassName)}>
                            {device.name}
                        </p>
                    </div>
                    {details}
                </div>
                {action}
            </div>
        );
    }

    return (
        <div className="flex items-start gap-2.5">
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                    <Icon aria-hidden="true" className="size-3.5 shrink-0 text-copy-secondary" />
                    <p className="min-w-0 flex-1 text-sm font-medium leading-5 text-foreground">{device.name}</p>
                </div>
                {details}
            </div>
            {action}
        </div>
    );
}

/** Devices that hold access to the computer, one summary each. */
export function DeviceList({
    className,
    devices,
    layout = "default",
    label,
}: {
    readonly className?: string;
    readonly devices: readonly DeviceDescription[];
    readonly layout?: "default" | "notice";
    readonly label: string;
}) {
    return (
        <ul aria-label={label} className={cn("space-y-2", className)}>
            {devices.map((device, index) => (
                <li key={`${index.toString()}:${device.name}`}>
                    <DeviceSummary device={device} layout={layout} />
                </li>
            ))}
        </ul>
    );
}
