import { CircleAlert, CircleCheck, Info, type LucideIcon, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const alertChrome =
    "flex gap-2 rounded-[20px] border-[0.5px] px-4 py-3 shadow-[0_8px_28px_rgba(23,30,36,0.06)] [overflow-wrap:anywhere]";

const alertTones = {
    error: {
        icon: CircleAlert,
        role: "alert",
        surface: "items-start border-destructive/20 bg-[oklch(0.97_0.02_27/0.6)] text-destructive backdrop-blur-[80px]",
    },
    warning: {
        icon: TriangleAlert,
        role: "alert",
        surface:
            "items-start border-[oklch(0.62_0.14_75/0.28)] bg-[oklch(0.98_0.03_85/0.6)] text-[oklch(0.52_0.13_70)] backdrop-blur-[80px]",
    },
    success: {
        icon: CircleCheck,
        role: "status",
        surface: "items-start border-success/20 bg-[oklch(0.97_0.025_163/0.6)] text-success backdrop-blur-[80px]",
    },
    info: {
        icon: Info,
        role: "status",
        surface:
            "items-start border-[oklch(0.55_0.1_250/0.28)] bg-[oklch(0.97_0.02_250/0.6)] text-[oklch(0.45_0.12_255)] backdrop-blur-[80px]",
    },
    neutral: {
        icon: null,
        role: "status",
        surface: "flex-col gap-1 border-border bg-surface-elevated text-foreground",
    },
} as const satisfies Record<
    string,
    {
        readonly icon: LucideIcon | null;
        readonly role: "alert" | "status";
        readonly surface: string;
    }
>;

export type MortyAlertTone = keyof typeof alertTones;

export function MortyAlert({
    children,
    className,
    description,
    icon,
    tone = "error",
}: {
    readonly children: ReactNode;
    readonly className?: string;
    readonly description?: ReactNode;
    readonly icon?: LucideIcon;
    readonly tone?: MortyAlertTone;
}) {
    const selected = alertTones[tone];
    const Icon = icon ?? selected.icon;
    return (
        <div className={cn(alertChrome, selected.surface, className)} role={selected.role}>
            {Icon !== null && <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />}
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-13">
                <div className="min-w-0">{children}</div>
                {description !== undefined && <div className="text-muted-foreground">{description}</div>}
            </div>
        </div>
    );
}
